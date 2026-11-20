import argparse
import sys
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional

from nsdeploy.action_discovery import prepare_actions
from nsdeploy.form_actions import action_discovery_config
from nsdeploy.generate import generate_site
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.linker import load_deploy_links
from nsdeploy.resolve import DeploymentPlan
from nsdeploy.resolve import build_plan
from nsdeploy.resolve import format_report
from nsdeploy.resolve import resolve_hocon
from nsdeploy.studio import DEFAULT_REF
from nsdeploy.studio import DEFAULT_REPO
from nsdeploy.theme import ThemeSpec

from nsbundle.studio_choice import StudioChoice


class NsBundle:
    """Produce a static web bundle from one agent-network HOCON, and nothing else.

    nsdeploy can do this already, as one branch of a tool that also resolves tools for
    a served site, hosts them as MCP servers, runs a public facade, themes a page with
    an LLM and registers a site with a community. This carries none of that: the
    pipeline is the same four nsdeploy calls — resolve, plan, generate, report — with
    `static_bundle=True` fixed and every option that cannot affect a static bundle
    absent from the command line rather than ignored at run time.

    What is deliberately missing, and why:

    * **No theming and no editable site source.** A bundle gets the default look.
      `--theme*` and `--site-dir` exist in nsdeploy to design a page; designing one is
      not what this tool is for, and dropping them also stops a build writing a
      `sites/<name>/` tree beside the caller's HOCON.
    * **No serving.** `--port`, `--no-serve` and the facade options describe a running
      site. A bundle is files.
    * **No Python tools.** `build_plan` is called with `include_python_tools=False`,
      which is what keeps a build from importing a coded tool or installing its
      dependencies. The report names what was left out.
    * **No community registration and no private steward.** Both are operator-side
      concerns of a deployment, and `generate_site` already excludes the steward from
      a static webroot.

    nsdeploy is used unchanged. Its pipeline takes a `ToolboxWorkspace`, and
    `StudioChoice` builds one from the command line, so there is nothing to join.
    """

    # Where a bundle lands when no output directory is named.
    OUTPUT_DIR_NAME: str = ".nsbundle"

    # A static bundle has no server to ask for a mock completion, so the runtime
    # answers in the browser. The same value nsdeploy uses for a static build.
    MOCK_ROUTER: str = "browser://mock"

    @staticmethod
    def main(argv: Optional[List[str]] = None) -> int:
        """
        Build one bundle.

        :param argv: The arguments, or None for `sys.argv`.
        :return: The process exit code.
        """
        args: argparse.Namespace = NsBundle.parse(argv)
        return NsBundle.build(args)

    @staticmethod
    # pylint: disable-next=too-many-statements  # one statement per retained option
    def parse(argv: Optional[List[str]] = None) -> argparse.Namespace:
        """
        Read the command line, and refuse a combination that cannot be built.

        :param argv: The arguments, or None for `sys.argv`.
        :return: The parsed options.
        :raises SystemExit: If the command line is unusable.
        """
        parser: argparse.ArgumentParser = argparse.ArgumentParser(
            prog="nsbundle",
            description="nsbundle — turn a neuro-san(-studio) agent-network HOCON into a "
                        "self-contained static webroot. The browser runs the agents, calls "
                        "the model with the visitor's own key, and reaches any external MCP "
                        "server directly, so the output can be served by any static host. "
                        "Usage: python -m nsbundle <network.hocon> [--studio DIR | --repo R "
                        "--ref REF] [--out DIR] [--site-url URL]")
        parser.add_argument("hocon", help="path to the agent-network HOCON")

        toolbox = parser.add_argument_group("toolbox", "where the files a network includes come from")
        toolbox.add_argument("--studio", default="",
                             help="local neuro-san-studio checkout (overrides GitHub)")
        toolbox.add_argument("--repo", default=DEFAULT_REPO,
                             help=f"GitHub repo for tool files (default {DEFAULT_REPO})")
        toolbox.add_argument("--ref", default=DEFAULT_REF, help=f"git ref/branch/tag (default {DEFAULT_REF})")
        toolbox.add_argument("--no-studio", action="store_true",
                             help="the network is self-contained: resolve no external toolbox at all")

        output = parser.add_argument_group("output", "what is written, and the origin baked into it")
        output.add_argument("--out", default=None,
                            help=f"output bundle dir (default: ./{NsBundle.OUTPUT_DIR_NAME}/<source-dir>/<name>)")
        output.add_argument("--site-url", default="",
                            help="public origin the bundle will be served from; it is baked into the "
                                 "manifest, the .well-known documents and every generated link. Leave "
                                 "it out only when serving at a domain root")
        output.add_argument("--runtime-dir", default=None,
                            help="neuro-san-web runtime dir (default: vendored nsdeploy/runtime)")

        runtime = parser.add_argument_group("runtime", "how the generated page behaves")
        runtime.add_argument("--upstream", default="https://api.openai.com/v1",
                             help="RUNTIME BYOK proxy upstream — where the page's key is forwarded "
                                  "(default OpenAI). A static bundle calls it directly, so it must allow CORS")
        runtime.add_argument("--mock-llm", action="store_true",
                             help="developer mode: make the deterministic keyless mock LLM the default")
        runtime.add_argument("--no-cruse", action="store_true",
                             help="don't inject the CRUSE generative-UI directive into agents")

        links = parser.add_argument_group("links", "binding dangling agent references to remote networks")
        links.add_argument("--links", default=None,
                           help="link sidecar JSON (default: <hocon>.links.json when present)")
        links.add_argument("--link", action="append", default=[], metavar="REF=URL",
                           help="bind a dangling agent reference to a remote nsDeploy network (repeatable)")

        NsBundle.add_action_options(parser)
        args: argparse.Namespace = parser.parse_args(argv)
        NsBundle.check(parser, args)
        return args

    @staticmethod
    def add_action_options(parser: argparse.ArgumentParser) -> None:
        """
        Add the browser-action options, which a bundle carries like any other site.

        :param parser: The parser to add them to.
        """
        actions = parser.add_argument_group("browser actions",
                                            "forms and APIs the generated page may drive on its own origin")
        actions.add_argument("--actions", default=None, metavar="FILE",
                             help="site-owned JavaScript action adapter")
        actions.add_argument("--action-page", action="append", default=None, metavar="PATH",
                             help="discover native HTML forms on this same-origin page at runtime "
                                  "(repeatable; no implicit page default)")
        actions.add_argument("--action-host-page", action="store_true",
                             help="discover native forms in the page embedding the widget (local only)")
        actions.add_argument("--action-site", metavar="URL",
                             help="discover public native forms and linked JSON OpenAPI 3 descriptions "
                                  "while bundling")
        actions.add_argument("--action-spec", metavar="FILE_OR_URL",
                             help="explicit OpenAPI 3 JSON description for --action-site")
        actions.add_argument("--action-lock", metavar="FILE",
                             help="reviewed discovery lock (default: <hocon>.discovered-actions.json)")
        actions.add_argument("--action-refresh", action="store_true",
                             help="rediscover actions; reset selections for review")
        actions.add_argument("--action-allow", action="append", default=[], metavar="NAME",
                             help="enable a discovered operation by exact name (repeatable)")
        actions.add_argument("--action-include-all", action="store_true",
                             help="enable every supported discovered operation; intended for public test sites")
        actions.add_argument("--action-max-pages", type=int, default=6,
                             help="maximum documentation/form pages to inspect (1-20, default 6)")
        actions.add_argument("--no-action-discovery", action="store_true",
                             help="disable automatic native-form discovery")
        actions.add_argument("--action-module", action="append", default=[], metavar="PATH",
                             help="existing same-origin module exporting registerActions "
                                  "(repeatable; not copied)")
        actions.add_argument("--action-caller-origin", action="append", default=[], metavar="ORIGIN",
                             help="allow this caller origin to use discovered forms remotely (repeatable)")

    @staticmethod
    def check(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
        """
        Refuse a combination of options that cannot produce a bundle.

        :param parser: The parser, which reports the error and exits.
        :param args: The parsed options.
        :raises SystemExit: If the options conflict.
        """
        if args.actions and not Path(args.actions).is_file():
            parser.error("--actions must name an existing JavaScript adapter")
        if args.no_studio and args.studio:
            parser.error("--no-studio and --studio ask for different toolboxes")
        # pylint: disable-next=too-many-boolean-expressions  # flat list of conflicting options
        if args.no_action_discovery and (args.action_page or args.action_host_page or args.action_caller_origin
                                         or args.action_site or args.action_spec or args.action_lock
                                         or args.action_refresh or args.action_allow or args.action_include_all):
            parser.error("--no-action-discovery cannot be combined with form discovery options")
        try:
            # The conventional discovery lock can also supply these capabilities.
            action_discovery_config(args.action_page or [], args.action_module,
                                    args.action_caller_origin, args.action_host_page, discovered=True)
        except ValueError as exception:
            parser.error(str(exception))

    @staticmethod
    # pylint: disable-next=too-many-locals  # one per stage of a linear build
    def build(args: argparse.Namespace) -> int:
        """
        Resolve the network, plan it, and write the bundle.

        :param args: The parsed options.
        :return: The process exit code.
        """
        hocon_path: Path = Path(args.hocon).resolve()
        if not hocon_path.is_file():
            print(f"error: HOCON not found: {hocon_path}", file=sys.stderr)
            return 2
        network_name: str = hocon_path.stem
        workspace: ToolboxWorkspace = StudioChoice.workspace(args.studio, args.repo, args.ref, args.no_studio)
        print(f"▶ Bundling {hocon_path.name} (toolbox: {workspace.identity()}) …\n")

        config: Dict[str, Any] = {}
        missing_includes: List[str] = []
        try:
            config, missing_includes = resolve_hocon(hocon_path, workspace)
        except Exception as exception:  # pylint: disable=broad-exception-caught
            # pyhocon reports a bad network through its own grammar and substitution
            # exceptions, which are not a type this tool can name. All of them mean the
            # same thing to the caller: the HOCON cannot be resolved, which is a message,
            # not a traceback.
            print(f"error: the HOCON could not be resolved: {exception}", file=sys.stderr)
            return 2
        try:
            NsBundle.apply_links(config, args, hocon_path, network_name)
        except ValueError as exception:
            print(f"error: {exception}", file=sys.stderr)
            return 2
        discovered: Optional[Dict[str, Any]] = None
        try:
            discovered = NsBundle.discover_actions(args, hocon_path, network_name)
            action_discovery_config(args.action_page or [], args.action_module,
                                    args.action_caller_origin, args.action_host_page, discovered=bool(discovered))
        except (ValueError, OSError) as exception:
            print(f"error: {exception}", file=sys.stderr)
            return 2

        try:
            plan: DeploymentPlan = build_plan(config, {}, network_name, missing_includes, workspace,
                                              include_python_tools=False)
        except Exception as exception:  # pylint: disable=broad-exception-caught
            # Embedded HOCON parsing raises the same parser-specific errors as top-level resolution.
            print(f"error: the HOCON could not be resolved: {exception}", file=sys.stderr)
            return 2
        if not plan.front_man:
            print("error: no front-man agent (an agent with `instructions` and no class/toolbox), "
                  "so the generated page would have nothing to talk to.", file=sys.stderr)
            return 2
        print(format_report(plan, static_bundle=True))
        print()

        out_dir: Path = NsBundle.output_dir(args, hocon_path, network_name)
        site_base: str = (args.site_url or "").rstrip("/")
        runtime_dir: Optional[Path] = Path(args.runtime_dir).resolve() if args.runtime_dir else None
        generate_site(plan, out_dir, NsBundle.MOCK_ROUTER, args.upstream.rstrip("/"), site_base,
                      cruse=not args.no_cruse, theme=ThemeSpec(), site_source_dir=None,
                      static_bundle=True, runtime_dir=runtime_dir,
                      actions_file=Path(args.actions).resolve() if args.actions else None,
                      action_pages=args.action_page or [], action_modules=args.action_module,
                      action_host_page=args.action_host_page,
                      action_caller_origins=args.action_caller_origin,
                      discovered_actions=discovered, mock_llm=args.mock_llm)
        NsBundle.report(plan, out_dir, bool(args.no_cruse))
        return 0

    @staticmethod
    def apply_links(config: Dict[str, Any], args: argparse.Namespace,
                    hocon_path: Path, network_name: str) -> None:
        """
        Merge the deploy-time link bindings into the resolved config.

        :param config: The resolved network config, changed in place.
        :param args: The parsed options.
        :param hocon_path: The network HOCON, which names the sidecar link file.
        :param network_name: The network's name.
        :raises ValueError: If a link file or an inline binding is invalid.
        """
        named: Optional[Path] = Path(args.links).resolve() if args.links else None
        if named is not None and not named.is_file():
            raise ValueError(f"link file not found: {named}")
        bindings: Dict[str, str] = load_deploy_links(hocon_path, network_name, named, args.link)
        if not bindings:
            return
        configured: Dict[str, Any] = dict(config.get("links", {}) or {})
        configured.update(bindings)
        config["links"] = configured

    @staticmethod
    def discover_actions(args: argparse.Namespace, hocon_path: Path,
                         network_name: str) -> Optional[Dict[str, Any]]:
        """
        Load or refresh the reviewed action lock, when this build asks for one.

        The lock is a reviewed file rather than build output, so it sits beside the
        HOCON like the link sidecar does, and never inside the bundle directory, which
        is disposable.

        :param args: The parsed options.
        :param hocon_path: The network HOCON, which names the sidecar lock file.
        :param network_name: The network's name, used when no HOCON suffix is present.
        :return: The lock document, or None when this build discovers nothing.
        :raises ValueError: If the lock is invalid or names an unknown action.
        :raises OSError: If the lock cannot be read or written.
        """
        if args.no_action_discovery:
            return None
        lock: Path = (Path(args.action_lock) if args.action_lock
                      else hocon_path.with_name(f"{network_name}.discovered-actions.json"))
        asked: bool = bool(args.action_site or args.action_spec or args.action_lock or args.action_refresh
                           or args.action_allow or args.action_include_all)
        if not asked and not lock.exists():
            return None
        return prepare_actions(lock, args.action_site, args.action_spec, args.site_url or "",
                               args.action_refresh, args.action_include_all,
                               args.action_allow, args.action_max_pages)

    @staticmethod
    def output_dir(args: argparse.Namespace, hocon_path: Path, network_name: str) -> Path:
        """
        Decide where the bundle is written.

        :param args: The parsed options.
        :param hocon_path: The network HOCON, whose directory names the default.
        :param network_name: The network's name.
        :return: The output directory.
        """
        if args.out:
            return Path(args.out).resolve()
        return Path.cwd() / NsBundle.OUTPUT_DIR_NAME / hocon_path.parent.name / network_name

    @staticmethod
    def report(plan: DeploymentPlan, out_dir: Path, no_cruse: bool) -> None:
        """
        Say what was written and what a static bundle cannot carry.

        :param plan: The plan the bundle was generated from.
        :param out_dir: Where the bundle was written.
        :param no_cruse: True when the generative-UI directive was left out.
        """
        print(f"✅ Generated static bundle → {out_dir}" + ("" if no_cruse else "  (+CRUSE generative UI)"))
        omitted: List[str] = sorted({tool.name for tool in plan.hostable_tools} | set(plan.omitted_tools))
        if omitted:
            print("   static bundle: omitted Python tools: " + ", ".join(omitted))
        if plan.external_mcps:
            print("   static bundle: external MCP servers will be called directly and must allow CORS")
        print("   static bundle: public MCP facade and private steward are not included")
