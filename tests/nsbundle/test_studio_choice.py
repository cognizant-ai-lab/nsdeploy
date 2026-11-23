import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from nsbundle.studio_choice import StudioChoice
from nsdeploy.interfaces.toolbox_workspace import ToolboxWorkspace
from nsdeploy.studio import Studio


class TestStudioChoice(unittest.TestCase):
    """Which toolbox a bundle reads.

    What these tests pin is that a checkout and a repository resolve to the very
    mirrors nsdeploy uses, so the two tools share one cache, and that no toolbox is
    a workspace that answers rather than fails.
    """

    def setUp(self) -> None:
        """
        Give each test a home directory of its own, where every mirror is created.
        """
        self.base: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.base)
        self.home: Path = self.base / "home"
        patcher = mock.patch.object(Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_checkout_shares_nsdeploys_mirror(self) -> None:
        """A network nsdeploy has built from this checkout is already mirrored."""
        checkout: Path = self.base / "studio"
        checkout.mkdir()
        chosen: ToolboxWorkspace = StudioChoice.workspace(studio=str(checkout))
        self.assertEqual(chosen.include_base(), Studio.local(checkout).include_base())

    def test_a_repository_shares_nsdeploys_mirror(self) -> None:
        """The repository cache is the expensive one to fill, so it is the one most
        worth sharing."""
        chosen: ToolboxWorkspace = StudioChoice.workspace(repo="owner/studio", ref="v1")
        self.assertEqual(chosen.include_base(), Studio.github("owner/studio", "v1").include_base())

    def test_a_checkout_wins_over_a_repository(self) -> None:
        """--repo and --ref have defaults, so naming a checkout must not be overridden
        by them."""
        checkout: Path = self.base / "studio"
        checkout.mkdir()
        chosen: ToolboxWorkspace = StudioChoice.workspace(str(checkout), "owner/studio", "v1")
        self.assertEqual(chosen.identity(), Studio.local(checkout).identity())

    def test_no_toolbox_resolves_nothing_and_fails_nothing(self) -> None:
        """A self-contained network bundles with no checkout and no network access."""
        chosen: ToolboxWorkspace = StudioChoice.workspace(no_studio=True, repo="owner/studio", ref="v1")
        self.assertIsNone(chosen.materialize("registries/aaosa.hocon"))
        self.assertTrue(chosen.include_base().is_dir())

    def test_no_toolbox_has_its_own_mirror(self) -> None:
        """It must not share a directory with any toolbox that does hold files."""
        empty: Path = StudioChoice.workspace(no_studio=True).include_base()
        self.assertEqual(empty, self.home / ".cache" / "nsdeploy" / StudioChoice.NO_TOOLBOX_DIR)
        self.assertNotEqual(empty, Studio.github("owner/studio", "v1").include_base())


if __name__ == "__main__":
    unittest.main()
