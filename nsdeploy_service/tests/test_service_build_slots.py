import asyncio
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeploymentStatus
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import READINESS_POLL_SECONDS
from nsdeploy_service.supervisor import Supervisor


class FakeProcess:
    """A child that is alive until the test retires it, standing in for nsdeploy.

    `pid` is deliberately 0: teardown calls os.killpg(os.getpgid(pid)), and any
    plausible-looking pid here would signal a real process group on the machine
    running the tests. Retiring the process first makes _terminate_tree return
    before it signals anything, and 0 keeps that harmless if it ever does not.
    """

    def __init__(self) -> None:
        self.pid = 0
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
        settings = Settings(work_root=Path(self._tmp.name), port_start=8560, port_end=8579,
                            max_deployments=10, max_concurrent_builds=1)
        self.supervisor = Supervisor(settings)
        self.generated = set()
        self.processes = []
        # Never answers, so every deployment stays in the readiness phase and only
        # the slot can let the next one start.
        # The three seams this test drives. Patched rather than mocked so the real
        # _build coroutine runs: the slot handover is what is under test.
        # pylint: disable=protected-access
        self.supervisor._spawn = self._spawn
        self.supervisor._site_is_ready_to_summarize = self._has_generated
        self.supervisor._site_is_ours = self._never_ready
        # pylint: enable=protected-access

    def tearDown(self) -> None:
        self.supervisor.store.close()
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
        # Retired before shutdown, so teardown has nothing to signal.
        for process in self.processes:
            process.retire()
        await self.supervisor.shutdown()


if __name__ == "__main__":
    unittest.main()
