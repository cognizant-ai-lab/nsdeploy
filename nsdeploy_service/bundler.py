from __future__ import annotations

import asyncio
import gzip
import hashlib
import io
import os
import tarfile
import tempfile
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Set
from typing import Tuple

from nsdeploy.generate import generate_site
from nsdeploy.resolve import DeploymentPlan
from nsdeploy.resolve import build_plan
from nsdeploy.resolve import resolve_hocon
from nsdeploy.studio import DEFAULT_REF
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.studio import GithubStudio
from nsdeploy.studio import LocalStudio
from nsdeploy.studio import StudioSource
from nsdeploy.theme import DEFAULT_THEME_MODEL
from nsdeploy.theme import ThemeSpec
from nsdeploy.theme import propose_theme

from nsdeploy_service import themespec
from nsdeploy_service.bundle_error import BundleError
from nsdeploy_service.bundle_result import BundleResult
from nsdeploy_service.config import Settings
from nsdeploy_service.models import BundleOptions
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import safe_network_name


class Bundler:
    """Build an agent network HOCON into a static bundle, in this process.

    A static bundle is not a deployment. `nsdeploy --static-bundle` generates the
    site and returns, instead of calling `launcher.serve()`, so there is no port, no
    child process to supervise and no lifecycle to persist. Nothing here reaches the
    store, and nothing about a bundle outlives the request that asked for it.

    That also answers the rule supervisor.py sets out, which is that nsdeploy is
    never imported in process. Both of its reasons are about a *deployment*:

      * `serve()` never returns, so an in-process call could not be torn down. A
        static build returns.
      * resolving a network may pip-install a coded tool's dependencies, which does
        not belong in an API process. `build_plan` is called here with
        `include_python_tools=False`, which is the switch that prevents it.

    So the build runs on a worker thread, bounded by a semaphore. A subprocess would
    pay a new interpreter and a fresh import of `nsdeploy.generate` for every
    request, and would have to read success out of exit status 0 — which the
    deployment supervisor treats as a crash.

    The one in-process import that was already here, `themespec`, sets the
    precedent: core is a vendored library, and a named seam is cheaper than a copy.

    A bundle is built either from an uploaded HOCON or from a deployment which is
    already serving one. The second is a REBUILD, not an export: a deployed site is
    generated for a server, and `static_bundle=True` changes the asset paths, the
    MCP facade, the tool URLs and the linking metadata, so the served tree cannot
    be repacked. Only the deployment's own choices are replayed.
    """

    # A static bundle has no server behind it, so the mock LLM answers in the
    # browser. This is the same literal nsdeploy's own __main__ uses.
    MOCK_ROUTER: str = "browser://mock"

    # Where the theming model is asked. This is NOT settings.upstream: that one is
    # the runtime endpoint baked into the page for the reader's own key.
    THEME_UPSTREAM: str = "https://api.openai.com/v1"

    def __init__(self, settings: Settings) -> None:
        """
        :param settings: The service settings, which hold the studio source, the
                         default upstream and the HOCON size limit.
        """
        self.settings: Settings = settings
        # Built with the Bundler, which the lifespan builds inside the loop, so the
        # semaphore belongs to the loop that will wait on it.
        self.slots: asyncio.Semaphore = asyncio.Semaphore(settings.max_concurrent_bundle_builds)

    async def build(self, hocon: bytes, options: BundleOptions) -> BundleResult:
        """
        Build one bundle and return it, without blocking the event loop.

        :param hocon: The agent network HOCON, as uploaded.
        :param options: The per-request overrides for this build.
        :return: The finished bundle.
        :raises BundleError: If the request cannot produce a bundle.
        """
        # Validated before a slot is taken, so a malformed upload is refused at once
        # instead of queueing behind other people's builds.
        text: str = self.read_hocon(hocon)
        result: Optional[BundleResult] = None
        async with self.slots:
            result = await asyncio.to_thread(self.build_now, text, options)
        return result

    def read_hocon(self, hocon: bytes) -> str:
        """
        Check an uploaded HOCON and decode it.

        :param hocon: The uploaded bytes.
        :return: The HOCON as text.
        :raises BundleError: If the upload is empty, too large, or not UTF-8.
        """
        if not hocon.strip():
            raise BundleError("the uploaded HOCON is empty")
        limit: int = self.settings.max_hocon_bytes
        if len(hocon) > limit:
            raise BundleError(f"HOCON is {len(hocon)} bytes; the limit is {limit}")
        text: str = ""
        try:
            text = hocon.decode("utf-8")
        except UnicodeDecodeError as exception:
            raise BundleError(f"HOCON must be UTF-8 text: {exception}") from exception
        return text

    def build_now(self, text: str, options: BundleOptions) -> BundleResult:
        """
        Resolve, generate and pack one bundle. Blocking; call it on a worker thread.

        :param text: The agent network HOCON.
        :param options: The per-request overrides for this build.
        :return: The finished bundle.
        :raises BundleError: If the request cannot produce a bundle.
        """
        name: str = self.safe_name(options.name)
        result: Optional[BundleResult] = None
        # The whole build is scratch: the tree is packed into memory and the
        # directory goes before the response is written.
        with tempfile.TemporaryDirectory(prefix="nsdeploy-bundle-") as scratch:
            result = self.build_in(Path(scratch), name, text, options)
        return result

    async def build_from_deployment(self, row: Dict[str, Any],
                                    options: BundleOptions) -> BundleResult:
        """
        Build one bundle from a deployment, without blocking the event loop.

        :param row: The persisted deployment record.
        :param options: The build options, from `deployment_options`.
        :return: The finished bundle.
        :raises BundleError: If the deployment cannot produce a bundle.
        """
        # Read before a slot is taken, so a record whose files are gone is refused
        # at once instead of queueing behind other people's builds.
        text: str = self.read_deployment_hocon(row)
        result: Optional[BundleResult] = None
        async with self.slots:
            result = await asyncio.to_thread(self.build_deployment_now, row, text, options)
        return result

    def build_deployment_now(self, row: Dict[str, Any], text: str,
                             options: BundleOptions) -> BundleResult:
        """
        Resolve, generate and pack one deployment's bundle. Blocking.

        :param row: The persisted deployment record.
        :param text: The HOCON the deployment was created from.
        :param options: The build options, from `deployment_options`.
        :return: The finished bundle.
        :raises BundleError: If the deployment cannot produce a bundle.
        """
        name: str = self.safe_name(row.get("name"))
        work_dir: Path = Path(row.get("work_dir") or "")
        result: Optional[BundleResult] = None
        with tempfile.TemporaryDirectory(prefix="nsdeploy-bundle-") as scratch:
            result = self.build_in(Path(scratch), name, text, options,
                                   deployment_work=work_dir)
        return result

    def read_deployment_hocon(self, row: Dict[str, Any]) -> str:
        """
        Read the HOCON a deployment was created from.

        :param row: The persisted deployment record.
        :return: The HOCON as text.
        :raises BundleError: If the record names no readable HOCON.
        """
        named: str = row.get("hocon_path") or ""
        if not named:
            raise BundleError("this deployment's record names no HOCON file")
        data: bytes = b""
        try:
            data = Path(named).read_bytes()
        except OSError as exception:
            raise BundleError(
                f"this deployment's HOCON cannot be read: {exception}") from exception
        return self.read_hocon(data)

    @staticmethod
    def deployment_options(row: Dict[str, Any], site_url: Optional[str],
                           upstream: Optional[str]) -> BundleOptions:
        """
        The build options for a bundle which must match a deployment.

        The deployment's own choices are replayed from its record, so the network is
        resolved and generated the way supervisor.py built the site. Only the hosting
        origin is new, because a bundle is served from somewhere this service cannot
        know. Theming is never asked for: the look comes from the deployment.

        :param row: The persisted deployment record.
        :param site_url: Where the client will host this bundle, if stated.
        :param upstream: A BYOK upstream for this bundle only, if stated.
        :return: The options for this build.
        """
        stored: Dict[str, Any] = row.get("options") or {}
        deployed: DeployOptions = DeployOptions(**stored)
        return BundleOptions(name=row.get("name"), site_url=site_url,
                             upstream=upstream or deployed.upstream,
                             cruse=deployed.cruse, theme=False)

    # pylint: disable-next=too-many-locals  # one linear build pipeline
    def build_in(self, work: Path, name: str, text: str, options: BundleOptions,
                 deployment_work: Optional[Path] = None) -> BundleResult:
        """
        Build one bundle inside a scratch directory.

        :param work: The scratch directory, removed by the caller.
        :param name: The validated network name.
        :param text: The agent network HOCON.
        :param options: The per-request overrides for this build.
        :param deployment_work: The work directory of the deployment this bundle
                                must match, or None for an uploaded HOCON. When it
                                is given the look is taken from the deployment and
                                no model is asked.
        :return: The finished bundle.
        :raises BundleError: If the network cannot be resolved or has no front man.
        """
        # nsdeploy takes the network name from the HOCON's filename stem, so the
        # name has to reach it as a filename and cannot be passed as an argument.
        hocon_path: Path = work / f"{name}.hocon"
        hocon_path.write_text(text, encoding="utf-8")
        source: StudioSource = self.studio_source()
        config: Dict[str, Any] = {}
        missing: List[str] = []
        try:
            config, missing = resolve_hocon(hocon_path, source)
        except Exception as exception:
            # pyhocon reports a syntax error with its own grammar exceptions, which
            # are not a type this service can name. A HOCON the caller can fix must
            # answer 400, so the whole class is turned into one here.
            raise BundleError(f"the HOCON could not be resolved: {exception}") from exception
        plan: DeploymentPlan = build_plan(config, {}, name, missing, source,
                                          include_python_tools=False)
        if not plan.front_man:
            raise BundleError(
                "this network has no front-man agent (an agent with `instructions` "
                "and no class/toolbox), so the generated page has nothing to talk to")
        warnings: List[str] = []
        theme: Optional[ThemeSpec] = None
        site_source: Optional[Path] = None
        if deployment_work is None:
            theme = self.make_theme(plan, options, warnings)
        else:
            # Read only. generate_site takes assets/, actions.js and site.js from
            # here; seed_site_source is the only writer and lives in nsdeploy's
            # __main__, so a bundle cannot disturb the deployment it describes.
            site_source = self.source_dir(deployment_work)
            theme = self.inherit_theme(deployment_work, warnings)
        out_dir: Path = work / "bundle"
        # Empty is allowed and means a bundle addressed relative to wherever it is
        # served, which only works at a domain root. A client that hosts the bundle
        # under a path has to say so, because the origin is baked into the manifest,
        # the .well-known document and every generated steward HOCON.
        site_base: str = (options.site_url or "").rstrip("/")
        byok_router: str = (options.upstream or self.settings.upstream).rstrip("/")
        cruse: bool = self.settings.cruse if options.cruse is None else options.cruse
        generate_site(plan, out_dir, self.MOCK_ROUTER, byok_router, site_base,
                      cruse=cruse, theme=theme, site_source_dir=site_source,
                      static_bundle=True)
        warnings.extend(self.describe_limits(plan))
        if deployment_work is not None:
            warnings.append(
                "this bundle is rebuilt from the deployment's HOCON, so anything "
                "which needs the deployment's own server — the public MCP facade "
                "and every hosted Python tool — works there and not here")
        return self.pack(name, out_dir, warnings)

    @staticmethod
    def source_dir(deployment_work: Path) -> Path:
        """
        The editable site source of a deployment.

        :param deployment_work: The deployment's work directory.
        :return: The site-source directory, as supervisor.py lays it out.
        """
        paths: Tuple[Path, Path] = themespec.site_paths(deployment_work)
        return paths[1]

    @staticmethod
    def inherit_theme(deployment_work: Path,
                      warnings: List[str]) -> Optional[ThemeSpec]:
        """
        The look a deployment has now, for a bundle which must match it.

        No model is asked. `themespec.read_spec` prefers the editable source,
        which is what the deployment's next build would use and what a token edit
        writes to, and falls back to the built site and then to the default look.

        :param deployment_work: The deployment's work directory.
        :param warnings: Collects the reason a fallback look was used.
        :return: The deployment's theme, or None for the default look.
        """
        spec: Optional[ThemeSpec] = None
        source: str = ""
        spec, source = themespec.read_spec(deployment_work)
        if source == "default":
            warnings.append("this deployment has no theme on disk, so the bundle "
                            "carries the default look")
            return None
        if source != "site-source":
            warnings.append("the deployment's editable source could not be read, "
                            "so the look is taken from its built site instead")
        return spec

    def make_theme(self, plan: DeploymentPlan, options: BundleOptions,
                   warnings: List[str]) -> Optional[ThemeSpec]:
        """
        Ask the model for a look, if this request asked for one.

        :param plan: The resolved network, which the prompt describes.
        :param options: The per-request overrides for this build.
        :param warnings: Collects the reason the default look was used instead.
        :return: The proposed theme, or None for the default look.
        """
        # Off unless this request asks, even when the service-wide THEME setting is
        # on. Theming calls a model and takes 30-90 seconds; a deployment can hold
        # that behind its 202, but this endpoint answers on the open connection, and
        # a service-wide default would make every bundle request a long one.
        if not options.theme:
            return None
        key: str = os.environ.get("OPENAI_API_KEY", "")
        if not key:
            warnings.append("a theme was asked for, but this service holds no "
                            "OPENAI_API_KEY; the default look is used")
            return None
        model: str = options.theme_model or self.settings.theme_model or DEFAULT_THEME_MODEL
        spec: ThemeSpec = propose_theme(plan, model=model, api_key=key,
                                        upstream=self.THEME_UPSTREAM,
                                        refresh=options.theme_refresh,
                                        theme_prompt=options.theme_prompt or None)
        # propose_theme catches every failure and answers with an empty spec, so an
        # empty body is how an unreachable model, or a layout the sanitizer refused,
        # reports itself. nsdeploy's own __main__ reads it the same way.
        if not spec.body:
            warnings.append(f"the theme step on {model} produced no usable layout; "
                            "the default look is used")
            return None
        return spec

    def studio_source(self) -> StudioSource:
        """
        Where `include` lines are resolved from.

        :return: A local checkout when one is configured, else the GitHub repo.
        """
        settings: Settings = self.settings
        if settings.studio:
            return LocalStudio(settings.studio)
        repo: str = settings.repo or DEFAULT_REPO
        ref: str = settings.ref or DEFAULT_REF
        return GithubStudio(repo, ref)

    @staticmethod
    def safe_name(raw: Optional[str]) -> str:
        """
        Validate the name which becomes the HOCON filename and the network name.

        :param raw: The name asked for, if any.
        :return: The validated name.
        :raises BundleError: If the name is not a plain identifier.
        """
        name: str = ""
        try:
            name = safe_network_name(raw or "network")
        except DeploymentError as exception:
            raise BundleError(str(exception)) from exception
        return name

    @staticmethod
    def describe_limits(plan: DeploymentPlan) -> List[str]:
        """
        What this bundle cannot carry, in the same terms nsdeploy's own report uses.

        :param plan: The resolved network.
        :return: One line for each limit which applies.
        """
        limits: List[str] = []
        omitted: Set[str] = set(plan.omitted_tools)
        names: str = ""
        # Every hostable tool needs a Python process, and a static bundle has none.
        for tool in plan.hostable_tools:
            omitted.add(tool.name)
        if omitted:
            names = ", ".join(sorted(omitted))
            limits.append(f"static bundle: omitted Python tools: {names}")
        if plan.missing_tools:
            names = ", ".join(sorted(plan.missing_tools))
            limits.append(f"these tools could not be resolved and are dropped: {names}")
        if plan.missing_includes:
            names = ", ".join(sorted(set(plan.missing_includes)))
            limits.append(f"these includes could not be found: {names}")
        if plan.external_mcps:
            limits.append("static bundle: external MCP servers are called straight from "
                          "the browser and must allow CORS")
        limits.append("static bundle: the public MCP facade is unavailable; private "
                      "stewards use fetch-and-run")
        return limits

    @staticmethod
    def pack(name: str, out_dir: Path, warnings: List[str]) -> BundleResult:
        """
        Pack the generated tree into a gzipped tar held in memory.

        The files are at the root of the archive, so `index.html` is at the root of
        whatever directory the archive is unpacked into. That is what bundle_host
        looks for, and it saves every reader a --strip-components.

        :param name: The network name, which names the archive.
        :param out_dir: The generated bundle directory.
        :param warnings: What the build has to report about this bundle.
        :return: The finished bundle.
        """
        paths: List[Path] = []
        # Sorted, so that two builds of one network pack in one order.
        for path in sorted(out_dir.rglob("*")):
            if path.is_file():
                paths.append(path)
        raw: io.BytesIO = io.BytesIO()
        total: int = 0
        # mtime=0 on the gzip header for the same reason the entries are flattened
        # below: the archive must be a function of its content and nothing else.
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
                # One entry for each generated file, with the ownership, mode and
                # timestamp flattened, so that one bundle always packs to one set of
                # bytes and the reported digest is an identity, not a receipt.
                for path in paths:
                    arcname: str = path.relative_to(out_dir).as_posix()
                    info: tarfile.TarInfo = archive.gettarinfo(str(path), arcname=arcname)
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    info.mtime = 0
                    info.mode = 0o644
                    total += info.size
                    with path.open("rb") as handle:
                        archive.addfile(info, handle)
        data: bytes = raw.getvalue()
        digest: str = hashlib.sha256(data).hexdigest()
        return BundleResult(name=name, archive=data, files=len(paths),
                            unpacked_bytes=total, sha256=digest, warnings=warnings)
