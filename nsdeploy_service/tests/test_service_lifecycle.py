import sqlite3
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from nsdeploy_service.app import create_app
from nsdeploy_service.bundler import Bundler
from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import Supervisor


class BuildQueueTest(unittest.TestCase):
    """What /health says about deployments waiting for a build slot.

    A deployment holds its slot for the build and the readiness poll, and the wait
    for a slot has no deadline of its own, so a stalled queue is otherwise silent:
    every waiting deployment simply reads `queued`.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self._supervisors = []

    def tearDown(self):
        # Each Supervisor owns an open SQLite handle; Windows will not unlink the
        # tempdir while one is still open, so close before cleanup.
        for supervisor in self._supervisors:
            supervisor.store.close()
        self._tmp.cleanup()

    def _supervisor(self, **overrides) -> Supervisor:
        settings = Settings(work_root=Path(self._tmp.name), port_start=8520, port_end=8539,
                            max_deployments=overrides.pop("max_deployments", 10), **overrides)
        supervisor = Supervisor(settings)
        self._supervisors.append(supervisor)
        return supervisor

    def _queue(self, supervisor: Supervisor, count: int, ages: tuple = ()):
        """
        Queue `count` deployments, optionally aged to fix their wait times.

        :param supervisor: The supervisor to create them on.
        :param count: How many to create.
        :param ages: Seconds to backdate each one by, in creation order.
        :return: The created deployments.
        """
        created = []
        # create() leaves a deployment QUEUED: it writes the work dir and reserves a
        # port, and start() is what schedules the build.
        for index in range(count):
            dep = supervisor.create(b'{"tools": []}', DeployOptions(name=f"net{index}"))
            if index < len(ages):
                dep.created_at = dep.created_at - timedelta(seconds=ages[index])
            created.append(dep)
        return created

    def test_an_idle_service_reports_an_empty_queue(self):
        """Nothing waiting and nothing building reports zero, not null."""
        supervisor = self._supervisor()
        queue = supervisor.build_queue()
        self.assertEqual(queue.get("waiting"), 0)
        self.assertEqual(queue.get("building"), 0)
        self.assertIsNone(queue.get("oldest_wait_seconds"))

    def test_the_slot_count_is_the_configured_limit(self):
        """Read with the queue so a client can tell "busy" from "saturated" without
        knowing the service's configuration."""
        supervisor = self._supervisor(max_concurrent_builds=2)
        self.assertEqual(supervisor.build_queue().get("slots"), 2)

    def test_queued_deployments_are_counted(self):
        """Every deployment waiting for a slot is in the count."""
        supervisor = self._supervisor()
        self._queue(supervisor, 3)
        self.assertEqual(supervisor.build_queue().get("waiting"), 3)

    def test_the_oldest_wait_is_the_longest_one(self):
        """The first deployment in is the one that has waited longest, and it is the
        number that says how bad a stall has become."""
        supervisor = self._supervisor()
        self._queue(supervisor, 3, ages=(90, 40, 5))
        self.assertEqual(supervisor.build_queue().get("oldest_wait_seconds"), 90)

    def test_a_building_deployment_is_not_waiting(self):
        """It holds a slot rather than waiting for one, so counting it as waiting
        would hide the very saturation this reports."""
        supervisor = self._supervisor()
        deployments = self._queue(supervisor, 2)
        deployments[0].status = DeploymentStatus.BUILDING
        queue = supervisor.build_queue()
        self.assertEqual(queue.get("building"), 1)
        self.assertEqual(queue.get("waiting"), 1)
        # Status only: nothing here ever took a slot.
        self.assertEqual(queue.get("slots_in_use"), 0)

    def test_a_terminal_deployment_is_in_neither_count(self):
        """A stopped record waits for nothing. Counting it would make a quiet service
        look permanently saturated."""
        supervisor = self._supervisor()
        deployments = self._queue(supervisor, 2)
        deployments[0].status = DeploymentStatus.STOPPED
        deployments[1].status = DeploymentStatus.FAILED
        queue = supervisor.build_queue()
        self.assertEqual(queue.get("waiting"), 0)
        self.assertEqual(queue.get("building"), 0)
        self.assertIsNone(queue.get("oldest_wait_seconds"))

    def test_health_reports_the_queue(self):
        """The block reaches the caller, not only the supervisor."""
        settings = Settings(work_root=Path(self._tmp.name) / "svc",
                            port_start=8540, port_end=8549, max_deployments=5,
                            max_concurrent_builds=2)
        with TestClient(create_app(settings)) as client:
            supervisor = client.app.state.supervisor
            supervisor.create(b'{"tools": []}', DeployOptions(name="waiting"))
            queue = client.get("/health").json()["build_queue"]
        self.assertEqual(queue["slots"], 2)
        self.assertEqual(queue["waiting"], 1)
        self.assertIsNotNone(queue["oldest_wait_seconds"])


class LifespanCleanupTest(unittest.TestCase):
    """Shutdown runs even when a background task ended badly.

    The studio warm-up is fire-and-forget, and shutdown awaits it to collect the
    task. Awaiting a task that raised re-raises at that point, so without care the
    deployment children and the store are left exactly as they are.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_a_failed_warm_up_does_not_skip_supervisor_shutdown(self):
        """A warm-up that raises must not leave the store open."""
        settings = Settings(work_root=Path(self._tmp.name), port_start=8750, port_end=8759,
                            max_deployments=5)
        # Raised from the source construction, which is outside warm_listing's own
        # handling, and not an OSError so _warm_studio cannot absorb it either.
        with mock.patch.object(Bundler, "studio_source", side_effect=RuntimeError("boom")):
            client = TestClient(create_app(settings))
            with client:
                supervisor = client.app.state.supervisor
        # Closing the store is the last thing shutdown() does, so a closed store
        # means the whole of it ran.
        with self.assertRaises(sqlite3.ProgrammingError):
            supervisor.store.count_by_status()


if __name__ == "__main__":
    unittest.main()
