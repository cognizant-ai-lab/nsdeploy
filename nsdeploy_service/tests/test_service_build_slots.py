import asyncio
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import READINESS_POLL_SECONDS
from nsdeploy_service.supervisor import DeploymentError
from nsdeploy_service.supervisor import Supervisor


class FakeProcess:
    """A fake child whose invalid PID cannot identify a real process group."""

    def __init__(self) -> None:
        self.pid = -1
        self.returncode = 0
        self.exited = False

    def retire(self) -> None:
        """Report the child as exited from now on."""
        self.exited = True

    def poll(self):
        """
        Report whether the child has exited.

        :return: None while running, else the exit status.
        """
        return self.returncode if self.exited else None

    def wait(self, timeout=None) -> int:  # pylint: disable=unused-argument
        """
        Reap the child, which has already stopped.

        :param timeout: Ignored; nothing here blocks.
        :return: The exit status.
        """
        self.exited = True
        return self.returncode

    def terminate(self) -> None:
        """Stop the child."""
        self.exited = True

    def kill(self) -> None:
        """Stop the child without waiting."""
        self.exited = True


class BuildSlotTest(unittest.IsolatedAsyncioTestCase):
    """A build slot covers generating the bundle, not waiting for the listener.

    The two phases cost different things: generating resolves includes and writes
    files, while waiting is one HTTP probe every half second. Bounding both with
    one semaphore let a site that was slow to bind a port hold capacity it was not
    using, and everything queued behind it waited for nothing.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.generated = set()
        self.processes = []
        self.install(slots=1)

    def install(self, slots: int) -> None:
        """
        Build the supervisor these tests drive.

        Most of them want one slot, so that only the slot can let the next
        deployment start. A test about the work-directory lock needs a spare slot,
        or the slot would hold the second build back and the test would pass
        whether the lock exists or not.

        :param slots: How many concurrent builds to allow.
        """
        settings = Settings(work_root=Path(self._tmp.name), port_start=8560, port_end=8579,
                            max_deployments=10, max_concurrent_builds=slots)
        self.supervisor = Supervisor(settings)
        # The seams these tests drive. Patched rather than mocked so the real
        # _build coroutine runs: the slot handover is what is under test.
        # _site_is_ours never answers, so a deployment stays in the readiness
        # phase and only a slot or the work lock can let the next one start.
        # pylint: disable=protected-access
        self.supervisor._spawn = self._spawn
        self.supervisor._site_is_ready_to_summarize = self._has_generated
        self.supervisor._site_is_ours = self._never_ready
        # pylint: enable=protected-access

    async def asyncTearDown(self) -> None:
        # Retired first, so _terminate_tree returns before it signals anything.
        # Here rather than at the end of each test, so a failed assertion still
        # stops the build tasks instead of leaving the suite to hang on them.
        for process in self.processes:
            process.retire()
        await self.supervisor.shutdown()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _spawn(self, _dep) -> FakeProcess:
        """
        Stand in for the nsdeploy subprocess.

        :param _dep: The deployment being built.
        :return: A process that stays alive until the test retires it.
        """
        process = FakeProcess()
        self.processes.append(process)
        return process

    def _has_generated(self, dep) -> bool:
        """
        Report whether this deployment's bundle has been written.

        :param dep: The deployment being built.
        :return: True once the test says its bundle exists.
        """
        return dep.id in self.generated

    @staticmethod
    def _never_ready(_dep) -> bool:
        """
        Report the site as never answering, so the readiness phase never ends.

        :param _dep: The deployment being built.
        :return: False, always.
        """
        return False

    async def _settle(self) -> None:
        """Let the build tasks run their next poll."""
        await asyncio.sleep(READINESS_POLL_SECONDS * 3)

    async def test_the_slot_is_released_once_the_bundle_exists(self):
        """A deployment whose bundle exists frees its slot while it waits for its
        site to answer, so the next deployment can start."""
        first = self.supervisor.create(b'{"tools": []}', DeployOptions(name="first"))
        second = self.supervisor.create(b'{"tools": []}', DeployOptions(name="second"))
        self.supervisor.start(first)
        await self._settle()
        # One slot, so the second must still be queued while the first generates.
        self.supervisor.start(second)
        await self._settle()
        self.assertEqual(second.status, DeploymentStatus.QUEUED)
        self.assertEqual(self.supervisor.build_queue().get("slots_in_use"), 1)

        self.generated.add(first.id)
        await self._settle()
        # The first is still BUILDING — its site has not answered — but it holds no
        # slot any more, so the second can start.
        self.assertEqual(first.status, DeploymentStatus.BUILDING)
        self.assertEqual(second.status, DeploymentStatus.BUILDING)
        queue = self.supervisor.build_queue()
        self.assertEqual(queue.get("waiting"), 0)
        self.assertEqual(queue.get("building"), 2)
        self.assertEqual(queue.get("slots_in_use"), 1)

    def _leave_previous_build(self, dep) -> None:
        """
        Write the artifacts a finished build leaves in the output directory.

        :param dep: The deployment whose output directory to seed.
        """
        dep.out_dir.mkdir(parents=True, exist_ok=True)
        # The two files bundle_ready() tests for, as a previous build left them.
        for name in ("agent-manifest.json", f"{dep.name}.network.json"):
            (dep.out_dir / name).write_text("{}", encoding="utf-8")

    def _stop_during(self, dep) -> None:
        """
        Stand in for a stop landing inside an await point of the build.

        Mirrors `_teardown` for a deployment whose process is still None: the port
        goes back to the pool, the status becomes STOPPED, and there is no child to
        signal.

        :param dep: The deployment being stopped.
        """
        self.supervisor.ports.release(dep.port)
        dep.status = DeploymentStatus.STOPPED

    async def test_a_stop_while_clearing_prevents_the_spawn(self):
        """Clearing is an await point. A stop completing inside it releases the port
        and finds no child to signal, so spawning afterwards would put one on a port
        the pool has already handed to the next deployment.
        """
        stopped = self.supervisor.create(b'{"tools": []}', DeployOptions(name="stopped"))
        # pylint: disable-next=protected-access
        self.supervisor._clear_readiness = self._stop_during
        self.supervisor.start(stopped)
        await self._settle()
        self.assertEqual(stopped.status, DeploymentStatus.STOPPED)
        self.assertEqual(self.processes, [], "a child was started for a stopped deployment")
        self.assertIsNone(stopped.process)

    async def test_a_stop_while_spawning_takes_the_child_with_it(self):
        """Spawning is an await point too, and the stop that landed in it could not
        see the child that came out. Left alone, _await_generated returns for the
        changed status and the child keeps serving on a released port.
        """
        stopped = self.supervisor.create(b'{"tools": []}', DeployOptions(name="racer"))
        # pylint: disable-next=protected-access
        self.supervisor._spawn = self._spawn_then_stop
        self.supervisor.start(stopped)
        await self._settle()
        self.assertEqual(stopped.status, DeploymentStatus.STOPPED)
        self.assertEqual(len(self.processes), 1)
        self.assertTrue(self.processes[0].exited, "the child outlived the deployment")
        self.assertIsNone(stopped.process)

    def _spawn_then_stop(self, dep) -> FakeProcess:
        """
        Spawn a child and have the deployment stopped in the same moment.

        :param dep: The deployment being built.
        :return: The started process.
        """
        process = self._spawn(dep)
        self._stop_during(dep)
        return process

    async def test_a_stop_during_clearing_does_not_fail_the_record(self):
        """_fail releases the port, so failing a deployment that has already been
        stopped releases it twice — and the second release can take the reservation
        of the replacement that has meanwhile claimed that port.
        """
        stopped = self.supervisor.create(b'{"tools": []}', DeployOptions(name="unlucky"))
        port = stopped.port
        # pylint: disable-next=protected-access
        self.supervisor._clear_readiness = self._stop_then_raise
        self.supervisor.start(stopped)
        await self._settle()
        self.assertEqual(stopped.status, DeploymentStatus.STOPPED,
                         "a stopped deployment was overwritten as failed")
        # Released once by the stop. A second release would hand this port out while
        # whoever reserved it next is still using it.
        self.assertNotIn(port, self.supervisor.ports.reserved())
        self.assertEqual(self.supervisor.ports.reserve(preferred=port), port)

    def _stop_then_raise(self, dep) -> None:
        """
        Stand in for a stop completing inside a clearing worker that then fails.

        :param dep: The deployment being cleared.
        :raises DeploymentError: Always, after the stop has landed.
        """
        self._stop_during(dep)
        raise DeploymentError("cannot clear the previous build's agent-manifest.json")

    async def test_one_build_at_a_time_per_work_directory(self):
        """A restart and a re-upload build in the directory of the deployment they
        replace. The outgoing build clears that directory from a worker thread, so
        two builds over one directory could have the old cleanup delete what the new
        one has just generated — which no later status check can undo.
        """
        # Two slots, so the slot cannot be what holds the second build back.
        self.supervisor.store.close()
        self.install(slots=2)
        first = self.supervisor.create(b'{"tools": []}', DeployOptions(name="shared"))
        # The replacement: a different Deployment over the same work directory, as
        # restart() and _replace() both build.
        second = self.supervisor.create(b'{"tools": []}', DeployOptions(name="other"))
        second.work_dir = first.work_dir
        second.out_dir = first.out_dir
        self.supervisor.start(first)
        await self._settle()
        self.supervisor.start(second)
        await self._settle()
        # Both hold a slot: the slot is taken before the lock, deliberately, so
        # that a build waiting for the lock cannot also be holding up the slot
        # its predecessor needs to finish. What the lock stops is the second one
        # reaching this directory at all.
        self.assertEqual(len(self.processes), 1,
                         "a second build ran in a directory already being built in")
        self.assertIsNone(second.process)

    async def test_the_lock_registry_does_not_grow_with_every_deployment(self):
        """MAX_DEPLOYMENTS bounds live deployments, not directories ever built in,
        and forget() drops a record without dropping its lock. A registry that only
        grew would keep an entry for every deploy/purge cycle of the service's life.
        """
        # Several deployments, each with its own work directory, built one after
        # another as a long-lived service would.
        for index in range(4):
            dep = self.supervisor.create(b'{"tools": []}',
                                         DeployOptions(name=f"churn{index}"))
            self.supervisor.start(dep)
            await self._settle()
            self._stop_during(dep)
            await self._settle()
        # pylint: disable-next=protected-access
        self.assertEqual(self.supervisor._work_locks, {},
                         "a lock was kept for a directory nothing is building in")
        # pylint: disable-next=protected-access
        self.assertEqual(self.supervisor._work_claims, {})

    async def test_a_waiting_build_keeps_the_lock_it_is_waiting_on(self):
        """Retiring a lock while a waiter holds a reference to it would let the next
        claim create a second Lock for one directory, which serializes nothing.
        """
        self.supervisor.store.close()
        self.install(slots=2)
        first = self.supervisor.create(b'{"tools": []}', DeployOptions(name="held"))
        second = self.supervisor.create(b'{"tools": []}', DeployOptions(name="waiter"))
        second.work_dir = first.work_dir
        second.out_dir = first.out_dir
        self.supervisor.start(first)
        await self._settle()
        self.supervisor.start(second)
        await self._settle()
        key = str(first.work_dir)
        # pylint: disable-next=protected-access
        held = self.supervisor._work_locks.get(key)
        # pylint: disable-next=protected-access
        self.assertEqual(self.supervisor._work_claims.get(key), 2)
        self._stop_during(first)
        await self._settle()
        # The waiter took the very same lock, not a fresh one.
        # pylint: disable-next=protected-access
        self.assertIs(self.supervisor._work_locks.get(key), held)

    async def test_a_previous_builds_artifacts_do_not_release_the_slot(self):
        """A restart or a re-upload keeps the deployment's output directory, so the
        last build's manifest and network JSON are already there when the next child
        starts. bundle_ready() tests only that they exist, so releasing the slot on
        them would hand it back before this build has resolved anything — and
        concurrent restarts would then resolve and generate with no bound at all.
        """
        # The real readiness test, against real files on disk.
        del self.supervisor._site_is_ready_to_summarize  # pylint: disable=protected-access
        first = self.supervisor.create(b'{"tools": []}', DeployOptions(name="first"))
        self._leave_previous_build(first)
        second = self.supervisor.create(b'{"tools": []}', DeployOptions(name="second"))
        self.supervisor.start(first)
        await self._settle()
        self.supervisor.start(second)
        await self._settle()
        # One slot. The first has generated nothing of its own yet, so it must still
        # hold it and the second must still be queued.
        self.assertEqual(self.supervisor.build_queue().get("slots_in_use"), 1)
        self.assertEqual(second.status, DeploymentStatus.QUEUED)


if __name__ == "__main__":
    unittest.main()
