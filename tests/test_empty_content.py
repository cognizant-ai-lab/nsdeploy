import unittest
from typing import List

from nsdeploy.studio_content.empty_content import EmptyContent


class TestEmptyContent(unittest.TestCase):
    """A toolbox that holds nothing.

    The contract these tests pin is that every question has a real answer: a build
    over this source takes the same path as a build over a checkout and resolves
    nothing, rather than meeting a None where a source was expected.
    """

    def setUp(self) -> None:
        """
        Make the source under test.
        """
        self.content: EmptyContent = EmptyContent()

    def test_the_identity_states_that_there_is_no_toolbox(self):
        """It is read in a failure, so it must not sound like a source that should
        have held the file."""
        self.assertEqual(self.content.identity(), "no external toolbox")

    def test_the_identity_names_no_path_and_no_host(self):
        """There is nowhere to look, so there is nothing to point a reader at."""
        for unwanted in ("/", "http", "github"):
            with self.subTest(unwanted=unwanted):
                self.assertNotIn(unwanted, self.content.identity())

    def test_the_revision_is_not_the_contracts_unknown(self):
        """An empty string means "cannot tell"; this source can tell."""
        self.assertNotEqual(self.content.revision(), "")

    def test_the_revision_is_the_same_for_every_instance(self):
        """It holds nothing now and will hold nothing later, so a build recorded
        against it compares equal to a rebuild."""
        self.assertEqual(self.content.revision(), EmptyContent().revision())

    def test_the_listing_is_empty(self):
        """The listing is empty."""
        listed: List[str] = self.content.list_paths()
        self.assertEqual(listed, [])

    def test_the_listing_is_a_fresh_list_each_time(self):
        """A caller that keeps the listing must not be able to add to this source by
        changing what it was given."""
        first: List[str] = self.content.list_paths()
        first.append("registries/aaosa.hocon")
        self.assertEqual(self.content.list_paths(), [])

    def test_every_file_reads_as_none(self):
        """A build asks for what its network named; none of it is here."""
        asked: List[str] = ["registries/aaosa.hocon", "coded_tools/web_fetch.py",
                            "toolbox/toolbox_info.hocon"]
        # One per path a network could plausibly name.
        for path in asked:
            with self.subTest(path=path):
                self.assertIsNone(self.content.read(path))

    def test_reading_cannot_fail(self):
        """No network, no filesystem and no credential, which is why a deployment that
        needs no toolbox cannot be stopped by one being unreachable."""
        odd: List[str] = ["", "..", "../../etc/passwd", "/etc/passwd"]
        # One per path that would make another source refuse or raise.
        for path in odd:
            with self.subTest(path=path):
                self.assertIsNone(self.content.read(path))


if __name__ == "__main__":
    unittest.main()
