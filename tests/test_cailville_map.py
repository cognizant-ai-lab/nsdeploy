import shutil
import tempfile
import unittest
from pathlib import Path

from nsdeploy.cailville_map import CailvilleMap


class TestCailvilleMap(unittest.TestCase):
    """
    Tests for CailvilleMap.
    """

    def setUp(self) -> None:
        """
        Create a Cailville directory that holds only the base map.
        """
        self.cailville: Path = Path(tempfile.mkdtemp())
        (self.cailville / "community.base.json").write_text("{}")

    def tearDown(self) -> None:
        """
        Remove the temporary Cailville directory.
        """
        shutil.rmtree(self.cailville)

    def test_active_path_falls_back_to_base_map(self) -> None:
        """
        Use the base map when no local active map exists.
        """
        self.assertEqual(CailvilleMap.active_path(self.cailville), self.cailville / "community.base.json")

    def test_active_path_prefers_local_map(self) -> None:
        """
        Use the local active map once it exists.
        """
        (self.cailville / "community.json").write_text("{}")
        self.assertEqual(CailvilleMap.active_path(self.cailville), self.cailville / "community.json")


if __name__ == "__main__":
    unittest.main()
