"""Re-uploading a network replaces it instead of standing up a second copy.

Identity is (organization, network name), because the name IS the HOCON's filename
stem — two uploads of `store_returns_ops.hocon` by the same organization are two
revisions of one network. Treating them as two filled the port pool with duplicates
that all answered the same thing, and left the map showing four pins for one system.

Four things survive a replacement, each tested below for its own reason. The port
matters most: a site's origin is baked into its generated bundle, so another
network's configured link to this one breaks the moment the port moves.
"""
import tempfile
import unittest
from pathlib import Path

from nsdeploy_service.app import _row_view
from nsdeploy_service.app import _view
from nsdeploy_service.config import Settings
from nsdeploy_service.models import DeployOptions
from nsdeploy_service.supervisor import Supervisor

HOCON = b'{"tools":[{"name":"front_man","instructions":"x","function":{"description":"d"}}]}'


class ReplaceOnReuploadTest(unittest.TestCase):
    """Re-uploading a network replaces the existing deployment."""
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with; cleaned up in tearDown
        self.root = Path(self._tmp.name)
        self.supervisor = Supervisor(Settings(
            work_root=self.root, port_start=8860, port_end=8869, max_deployments=10))

    def tearDown(self):
        self.supervisor.store.close()
        self._tmp.cleanup()

    def _upload(self, name, org, body=HOCON):
        return self.supervisor.create(body, DeployOptions(name=name, org_name=org))

    def _rows(self):
        return self.supervisor.store.list_deployments()

    def test_second_upload_replaces_rather_than_duplicates(self):
        """A second upload replaces the deployment rather than duplicating it."""
        first = self._upload("store_returns_ops", "Acme")
        second = self._upload("store_returns_ops", "Acme", HOCON + b"\n# edited\n")

        self.assertEqual(len(self._rows()), 1, "a re-upload must not add a record")
        self.assertEqual(second.id, first.id)
        # The whole reason the port is preserved: other networks link to this URL.
        self.assertEqual(second.port, first.port)
        self.assertEqual(second.url, first.url)
        self.assertEqual(second.position, first.position,
                         "the pin must not jump when a network is edited")
        self.assertIn("# edited", second.hocon_path.read_text(encoding="utf-8"),
                      "the replacement must build from the NEW upload")

    def test_a_different_organization_is_a_different_network(self):
        """A different organization gets a different network."""
        mine = self._upload("store_returns_ops", "Acme")
        theirs = self._upload("store_returns_ops", "Globex")
        self.assertEqual(len(self._rows()), 2)
        self.assertNotEqual(theirs.id, mine.id)
        self.assertNotEqual(theirs.port, mine.port)

    def test_a_different_name_is_a_different_network(self):
        """A different name gets a different network."""
        self._upload("store_returns_ops", "Acme")
        other = self._upload("order_management", "Acme")
        self.assertEqual(len(self._rows()), 2)
        self.assertEqual(other.name, "order_management")

    def test_a_replacement_stays_published(self):
        """A revision of a published network is still published.

        Dropping it off the map on every edit would make an edit look like a
        withdrawal, and `save_deployment` deliberately never writes that column.
        """
        first = self._upload("store_returns_ops", "Acme")
        self.assertTrue(first.published_at, "autopublish is the service default")
        second = self._upload("store_returns_ops", "Acme")
        self.assertTrue(second.published_at)
        row = self.supervisor.store.get_deployment(second.id)
        self.assertTrue(row.get("published_at"))

    def test_replacing_does_not_leak_ports(self):
        """Ten re-uploads of one network must occupy exactly one port.

        The pool is the scarce resource — on Azure it is five ports wide — so a
        replacement that reserved a new port each time would exhaust it in a few
        edits, which is the bug this replaces.
        """
        for index in range(10):
            self._upload("store_returns_ops", "Acme", HOCON + f"\n# {index}\n".encode())
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(len(self.supervisor.ports.reserved()), 1)

    def test_the_new_uploads_options_win(self):
        """A re-upload is a fresh deploy, not a restart replaying old choices."""
        self._upload("store_returns_ops", "Acme")
        second = self.supervisor.create(HOCON, DeployOptions(
            name="store_returns_ops", org_name="Acme", theme_prompt="dark navy"))
        self.assertEqual(second.options.theme_prompt, "dark navy")

    def test_only_the_replacing_upload_reports_it(self):
        """`replaced` describes one request, not the network.

        It is deliberately absent from `as_row`, so a later list or get of the same
        record must report False — otherwise the console would keep announcing a
        replacement that happened hours ago.
        """
        first = self._upload("store_returns_ops", "Acme")
        self.assertFalse(_view(first).replaced)

        second = self._upload("store_returns_ops", "Acme", HOCON + b"\n#e\n")
        self.assertTrue(_view(second).replaced)

        row = self.supervisor.store.get_deployment(second.id)
        self.assertFalse(_row_view(row, self.supervisor.settings).replaced,
                         "a read of the record must not claim a replacement")


if __name__ == "__main__":
    unittest.main()
