#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger("publish_load_test")

DEFAULT_BASE_URL = "https://agentic-city-dev.decisionai.ml"
# Hosts that the test may load without --allow-host. Production is never on this list.
SAFE_HOSTS = ("agentic-city-dev.decisionai.ml", "localhost", "127.0.0.1")
DEFAULT_HOCONS = ("link_demo_airline.hocon", "link_demo_travel_agency.hocon", "kitchenasty_ordering_agent.hocon")
TOKEN_ENV = "NSDEPLOY_LOADTEST_TOKEN"
LIVE_STATUSES = ("queued", "building")
CAP_MESSAGE = "maximum of"


class PublishLoadTest:
    """
    Simulates neuro-san-ui users who publish networks to an nsdeploy service, then removes what they made.

    Each virtual user publishes its networks one after another with the requests that `publishNetwork` in
    neuro-san-ui (`packages/ui-common/controller/publish/Publish.ts`) makes: a multipart `POST /deployments`,
    then `GET /deployments/{id}/wait` until the status leaves `queued`/`building`. Every user owns one
    organization named `<prefix>-<run>-uNN`, so cleanup can find everything the test made.
    """

    def __init__(self, args: argparse.Namespace, token: str):
        """
        Keep the options of one run.

        :param args: The parsed command line
        :param token: The service API token
        """
        self._args: argparse.Namespace = args
        self._base: str = args.base_url.rstrip("/")
        self._headers: Dict[str, str] = {"Authorization": f"Bearer {token}"}
        self._run_id: str = args.run_id or time.strftime("%m%d%H%M")
        self._results: List[Dict[str, Any]] = []
        self._health_samples: List[Dict[str, Any]] = []
        self._stop_sampling: asyncio.Event = asyncio.Event()

    @staticmethod
    def main() -> int:
        """
        Run the test from the command line.

        :return: The process exit code: 0 when every publish and the cleanup succeed
        """
        args: argparse.Namespace = PublishLoadTest.parse_args(sys.argv[1:])
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
        # httpx logs every request at INFO, which buries the per-publish lines.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        host: str = urlparse(args.base_url).hostname or ""
        if host not in SAFE_HOSTS and not args.allow_host:
            logger.error("Refusing to load %s; pass --allow-host to target a host not in %s", host, SAFE_HOSTS)
            return 2
        token: str = os.environ.get(TOKEN_ENV, "")
        if not token:
            logger.error("Set %s to the service API token", TOKEN_ENV)
            return 2
        return asyncio.run(PublishLoadTest(args, token).run())

    @staticmethod
    def parse_args(argv: List[str]) -> argparse.Namespace:
        """
        Parse the command line.

        :param argv: The arguments, without the program name
        :return: The parsed options
        """
        examples: Path = Path(__file__).resolve().parents[2] / "examples"
        parser = argparse.ArgumentParser(description="Load test nsdeploy with simulated neuro-san-ui publishes.")
        parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="the nsdeploy service URL")
        parser.add_argument("--allow-host", action="store_true", help="allow a host that is not in SAFE_HOSTS")
        parser.add_argument("--users", type=int, default=1, help="the number of simulated users")
        parser.add_argument("--networks-per-user", type=int, default=3, help="the publishes each user makes")
        parser.add_argument("--hocon", action="append", default=None,
                            help="a HOCON to publish; repeat for more. Users take them in turn")
        parser.add_argument("--examples", type=Path, default=examples, help="the directory of the default HOCONs")
        parser.add_argument("--ramp-seconds", type=float, default=0.0, help="spread the user start times over this")
        parser.add_argument("--no-theme", action="store_true", help="send theme=false instead of the UI's true")
        parser.add_argument("--wait-timeout", type=int, default=60, help="the /wait timeout the UI uses")
        parser.add_argument("--publish-timeout", type=float, default=1200.0, help="give up on one publish after this")
        parser.add_argument("--status-poll-seconds", type=float, default=2.0,
                            help="how often to read the status, to time the queue; 0 turns it off")
        parser.add_argument("--org-prefix", default="loadtest", help="the start of every test organization name")
        parser.add_argument("--run-id", default="", help="the run label in organization names; default: MMDDHHMM")
        parser.add_argument("--keep", action="store_true", help="leave the deployments running")
        parser.add_argument("--cleanup-only", action="store_true",
                            help="remove every deployment and organization under --org-prefix, then exit")
        parser.add_argument("--report", type=Path, default=None, help="write the results as JSON here")
        return parser.parse_args(argv)

    async def run(self) -> int:
        """
        Run the publishes, then clean up.

        :return: The process exit code
        """
        timeout = httpx.Timeout(self._args.wait_timeout + 30.0, connect=10.0)
        async with httpx.AsyncClient(headers=self._headers, timeout=timeout, follow_redirects=True) as client:
            baseline: Dict[str, Any] = await self.get_json(client, "/health")
            logger.info("Service build %s, deployments %s, reserved ports %d", baseline.get("build"),
                        baseline.get("deployments"), len(baseline.get("port_pool", {}).get("reserved", [])))
            if self._args.cleanup_only:
                return 0 if await self.cleanup(client, self._args.org_prefix + "-", baseline) else 1
            sampler: asyncio.Task = asyncio.create_task(self.sample_health(client))
            started: float = time.monotonic()
            users: List[Any] = []
            # Start each simulated user, spread over the ramp.
            for user in range(self._args.users):  # type: int
                users.append(self.simulate_user(client, user))
            await asyncio.gather(*users)
            elapsed: float = time.monotonic() - started
            self._stop_sampling.set()
            await sampler
            cleaned: bool = True
            if not self._args.keep:
                cleaned = await self.cleanup(client, f"{self._args.org_prefix}-{self._run_id}-", baseline)
        summary: Dict[str, Any] = self.summarize(elapsed)
        logger.info("Summary: %s", json.dumps(summary, indent=2))
        if self._args.report:
            report: Dict[str, Any] = {"summary": summary, "publishes": self._results, "health": self._health_samples}
            self._args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
            logger.info("Report written to %s", self._args.report)
        return 0 if summary.get("ready") == summary.get("publishes") and cleaned else 1

    async def simulate_user(self, client: httpx.AsyncClient, user: int) -> None:
        """
        Publish one user's networks one after another, as one person in the UI would.

        :param client: The HTTP client
        :param user: The user number
        """
        if self._args.users > 1 and self._args.ramp_seconds > 0:
            await asyncio.sleep(self._args.ramp_seconds * user / (self._args.users - 1))
        org_name: str = f"{self._args.org_prefix}-{self._run_id}-u{user:02d}"
        hocons: List[Path] = self.hocon_paths()
        # Publish this user's networks, taking the HOCONs in turn.
        for index in range(self._args.networks_per_user):  # type: int
            hocon: Path = hocons[(user + index) % len(hocons)]
            name: str = f"lt{user:02d}_{index:02d}_{hocon.stem}"[:64]
            result: Dict[str, Any] = await self.publish(client, org_name, name, hocon)
            self._results.append(result)
            logger.info("%s/%s: %s in %.1fs (queued %.1fs) %s", org_name, name, result.get("outcome"),
                        result.get("total_seconds") or 0.0, result.get("queued_seconds") or 0.0,
                        result.get("error") or "")

    def hocon_paths(self) -> List[Path]:
        """
        List the HOCONs to publish.

        :return: The paths of the HOCON files
        """
        paths: List[Path] = []
        # Take the HOCONs from the command line, else the default examples.
        for entry in self._args.hocon or DEFAULT_HOCONS:  # type: str
            path: Path = Path(entry)
            paths.append(path if path.is_file() else self._args.examples / entry)
        return paths

    async def publish(self, client: httpx.AsyncClient, org_name: str, name: str, hocon: Path) -> Dict[str, Any]:
        """
        Publish one network as neuro-san-ui does and time each stage.

        :param client: The HTTP client
        :param org_name: The owning organization
        :param name: The network name
        :param hocon: The HOCON file
        :return: The result record of this publish
        """
        result: Dict[str, Any] = {"org_name": org_name, "name": name, "hocon": hocon.name, "outcome": "error"}
        started: float = time.monotonic()
        # The Publish panel lists the networks before the user presses Publish.
        await client.get(self._base + "/deployments")
        files: Dict[str, Any] = {"file": (f"{name}.hocon", hocon.read_bytes(), "text/plain")}
        form: Dict[str, str] = {"name": name, "org_name": org_name,
                                "theme": "false" if self._args.no_theme else "true", "theme_refresh": "false"}
        try:
            response: httpx.Response = await client.post(self._base + "/deployments", files=files, data=form)
        except httpx.HTTPError as error:
            result["error"] = f"POST failed: {error!r}"
            return result
        result["post_seconds"] = round(time.monotonic() - started, 2)
        result["post_status"] = response.status_code
        if response.status_code != 202:
            text: str = response.text[:300]
            result["outcome"] = "refused_at_cap" if CAP_MESSAGE in text else "rejected"
            result["error"] = f"HTTP {response.status_code}: {text}"
            return result
        network: Dict[str, Any] = response.json()
        result["id"] = network.get("id")
        stages: Dict[str, float] = {}
        poller: Optional[asyncio.Task] = None
        if self._args.status_poll_seconds > 0:
            poller = asyncio.create_task(self.poll_status(client, network.get("id"), started, stages))
        try:
            network = await asyncio.wait_for(self.wait_until_settled(client, network), self._args.publish_timeout)
        except asyncio.TimeoutError:
            result["outcome"] = "timeout"
            result["error"] = f"still {network.get('status')} after {self._args.publish_timeout}s"
            return result
        except httpx.HTTPError as error:
            result["error"] = f"wait failed: {error!r}"
            return result
        finally:
            if poller:
                poller.cancel()
        await self.record_settled(client, result, network, time.monotonic() - started, stages)
        return result

    async def record_settled(self, client: httpx.AsyncClient, result: Dict[str, Any], network: Dict[str, Any],
                             total: float, stages: Dict[str, float]) -> None:
        """
        Record how a publish ended and, when it is ready, whether its site answers.

        :param client: The HTTP client
        :param result: The result record to fill in
        :param network: The settled deployment
        :param total: The seconds from the start of the publish to the end of the wait
        :param stages: The seconds from the start to the first sight of each status
        """
        result["total_seconds"] = round(total, 2)
        result["queued_seconds"] = stages.get("building")
        if stages.get("building") is not None:
            result["building_seconds"] = round(total - stages.get("building"), 2)
        result["status"] = network.get("status")
        result["url"] = network.get("url")
        if network.get("status") != "ready" or not network.get("url"):
            result["outcome"] = "failed"
            result["error"] = network.get("error") or f"ended as {network.get('status')}"
            return
        result["outcome"] = "ready"
        result["site_ok"] = await self.check_site(client, network)

    async def wait_until_settled(self, client: httpx.AsyncClient, network: Dict[str, Any]) -> Dict[str, Any]:
        """
        Call `/wait` until the deployment is no longer queued or building; a 504 means it is still building.

        :param client: The HTTP client
        :param network: The deployment as the POST returned it
        :return: The settled deployment
        """
        path: str = f"/deployments/{network.get('id')}/wait"
        # Wait again while the build has not finished, as the UI does.
        while network.get("status") in LIVE_STATUSES:
            response: httpx.Response = await client.get(self._base + path,
                                                        params={"timeout": str(self._args.wait_timeout)})
            if response.status_code != 504:
                response.raise_for_status()
                network = response.json()
        return network

    async def poll_status(self, client: httpx.AsyncClient, deployment_id: str, started: float,
                          stages: Dict[str, float]) -> None:
        """
        Record when a deployment first reports each status, to split queue time from build time.

        :param client: The HTTP client
        :param deployment_id: The deployment
        :param started: The monotonic time the publish started
        :param stages: Filled with the seconds from the start to the first sight of each status
        """
        # Poll until the publish task cancels this one.
        while True:
            try:
                response: httpx.Response = await client.get(f"{self._base}/deployments/{deployment_id}")
                status: str = response.json().get("status", "")
                if status and status not in stages:
                    stages[status] = round(time.monotonic() - started, 2)
            except (httpx.HTTPError, ValueError) as error:
                logger.warning("Status read for %s failed: %r", deployment_id, error)
            await asyncio.sleep(self._args.status_poll_seconds)

    async def check_site(self, client: httpx.AsyncClient, network: Dict[str, Any]) -> bool:
        """
        Check that the published site serves its page and its network definition.

        :param client: The HTTP client
        :param network: The ready deployment
        :return: True when both answer 200
        """
        url: str = network.get("url", "").rstrip("/")
        ok: bool = True
        # Fetch the page and the network definition of the site.
        for path in ("/", f"/{network.get('name')}.network.json"):  # type: str
            try:
                response: httpx.Response = await client.get(url + path)
            except httpx.HTTPError as error:
                logger.warning("Site %s%s failed: %r", url, path, error)
                ok = False
                continue
            if response.status_code != 200:
                logger.warning("Site %s%s answered %d", url, path, response.status_code)
                ok = False
        return ok

    async def sample_health(self, client: httpx.AsyncClient) -> None:
        """
        Read `/health` every 10 seconds until the publishes finish, then once more,
        so a run shorter than the interval still records its peak.

        :param client: The HTTP client
        """
        # Sample until the run sets the stop event.
        while not self._stop_sampling.is_set():
            await self.record_health(client)
            try:
                await asyncio.wait_for(self._stop_sampling.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                pass
        await self.record_health(client)

    async def record_health(self, client: httpx.AsyncClient) -> None:
        """
        Read `/health` once and keep its deployment counts and reserved ports.

        :param client: The HTTP client
        """
        try:
            health: Dict[str, Any] = await self.get_json(client, "/health")
            self._health_samples.append({"t": time.time(), "deployments": health.get("deployments"),
                                         "reserved": len(health.get("port_pool", {}).get("reserved", []))})
        except (httpx.HTTPError, ValueError) as error:
            logger.warning("Health read failed: %r", error)

    async def cleanup(self, client: httpx.AsyncClient, org_start: str, baseline: Dict[str, Any]) -> bool:
        """
        Stop and remove every deployment of the test organizations, then delete the organizations.

        :param client: The HTTP client
        :param org_start: The start of the test organization names
        :param baseline: The `/health` from before the run
        :return: True when nothing of the test remains and the reserved ports are back to the baseline
        """
        deployments: List[Dict[str, Any]] = (await self.get_json(client, "/deployments")).get("deployments", [])
        clean: bool = True
        # Stop each test deployment, then remove its record; a running one cannot be removed.
        for deployment in deployments:  # type: Dict[str, Any]
            if not deployment.get("org_name", "").startswith(org_start):
                continue
            path: str = f"{self._base}/deployments/{deployment.get('id')}"
            stop: httpx.Response = await client.delete(path)
            purge: httpx.Response = await client.delete(path, params={"purge": "true"})
            if stop.status_code != 200 or purge.status_code != 200:
                logger.error("Removing %s failed: stop %d, purge %d %s", deployment.get("id"), stop.status_code,
                             purge.status_code, purge.text[:200])
                clean = False
        clean = await self.delete_orgs(client, org_start) and clean
        health: Dict[str, Any] = await self.get_json(client, "/health")
        before: int = len(baseline.get("port_pool", {}).get("reserved", []))
        after: int = len(health.get("port_pool", {}).get("reserved", []))
        logger.info("Reserved ports: %d before the run, %d after cleanup", before, after)
        return clean and after <= before

    async def delete_orgs(self, client: httpx.AsyncClient, org_start: str) -> bool:
        """
        Delete the test organizations.

        :param client: The HTTP client
        :param org_start: The start of the test organization names
        :return: True when every test organization is deleted
        """
        orgs: List[Dict[str, Any]] = (await self.get_json(client, "/orgs")).get("organizations", [])
        clean: bool = True
        removed: int = 0
        # Delete each test organization, which now owns no deployment records.
        for org in orgs:  # type: Dict[str, Any]
            if not org.get("name", "").startswith(org_start):
                continue
            response: httpx.Response = await client.delete(f"{self._base}/orgs/{org.get('id')}")
            if response.status_code != 204:
                logger.error("Deleting organization %s failed: %d %s", org.get("name"), response.status_code,
                             response.text[:200])
                clean = False
            removed += 1
        logger.info("Deleted %d test organizations", removed)
        return clean

    async def get_json(self, client: httpx.AsyncClient, path: str) -> Dict[str, Any]:
        """
        GET a service path and decode its JSON.

        :param client: The HTTP client
        :param path: The path on the service
        :return: The decoded body
        :raises httpx.HTTPStatusError: When the service does not answer 2xx
        """
        response: httpx.Response = await client.get(self._base + path)
        response.raise_for_status()
        return response.json()

    def summarize(self, elapsed: float) -> Dict[str, Any]:
        """
        Count the outcomes and give the timing percentiles.

        :param elapsed: The wall-clock seconds the publishes took
        :return: The summary
        """
        outcomes: Dict[str, int] = {}
        totals: List[float] = []
        queued: List[float] = []
        site_failures: int = 0
        # Tally each publish.
        for result in self._results:  # type: Dict[str, Any]
            outcomes[result.get("outcome")] = outcomes.get(result.get("outcome"), 0) + 1
            if result.get("outcome") == "ready":
                totals.append(result.get("total_seconds"))
                if result.get("site_ok") is False:
                    site_failures += 1
            if result.get("queued_seconds") is not None:
                queued.append(result.get("queued_seconds"))
        peak_reserved: int = 0
        # Find the most ports reserved at once.
        for sample in self._health_samples:  # type: Dict[str, Any]
            peak_reserved = max(peak_reserved, sample.get("reserved", 0))
        return {"run_id": self._run_id, "publishes": len(self._results), "ready": outcomes.get("ready", 0),
                "outcomes": outcomes, "site_failures": site_failures, "elapsed_seconds": round(elapsed, 1),
                "time_to_ready": self.percentiles(totals), "queued": self.percentiles(queued),
                "peak_reserved_ports": peak_reserved}

    @staticmethod
    def percentiles(values: List[float]) -> Dict[str, Optional[float]]:
        """
        Give the median, 95th percentile and maximum of some timings.

        :param values: The timings in seconds
        :return: The percentiles, or Nones when there are no values
        """
        if not values:
            return {"p50": None, "p95": None, "max": None}
        ordered: List[float] = sorted(values)
        p95: float = ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]
        return {"p50": round(statistics.median(ordered), 2), "p95": round(p95, 2), "max": round(ordered[-1], 2)}


if __name__ == "__main__":
    sys.exit(PublishLoadTest.main())
