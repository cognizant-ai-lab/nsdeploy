import shutil
import tempfile
import unittest
from pathlib import Path
from typing import List

from nsdeploy.studio_content.local_content import LocalContent


class TestLocalContent(unittest.TestCase):
    """A studio read from a checkout on this machine.

    The contract these tests pin is `ToolboxContent`'s: a flat list of paths, bytes
    by path, an identity fit for a build log, and a revision when one is knowable.
    Nothing about mirrors or include bases, because a content source has none.
    """

    def setUp(self) -> None:
        """
        Create a checkout laid out like neuro-san-studio, with the noise a real one has.
        """
        # Resolved, because LocalContent resolves too: on macOS a temp directory is
        # reached through a symbolic link, and resolving it is what makes the
        # check for a path leaving the checkout sound.
        self.checkout: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.checkout)
        self.write("registries/aaosa.hocon", "{}")
        self.write("neuro_san_studio/toolbox/toolbox_info.hocon", "{}")
        self.write("coded_tools/web_fetch.py", "VALUE = 1\n")
        self.content: LocalContent = LocalContent(self.checkout)

    def write(self, rel_path: str, text: str) -> None:
        """
        Write one file into the checkout.

        :param rel_path: The path relative to the checkout.
        :param text: The file contents.
        """
        path: Path = self.checkout / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    # --- identity and revision --------------------------------------------
    def test_the_identity_is_the_checkout_path(self):
        """A reader needs to know which directory a missing file was looked for in."""
        self.assertEqual(self.content.identity(), str(self.checkout))

    def test_a_directory_that_is_not_a_working_tree_has_no_revision(self):
        """A plain directory is still a valid studio, so this reports rather than
        raises."""
        self.assertEqual(self.content.revision(), "")

    def test_the_revision_follows_a_head_reference(self):
        """The usual case: HEAD names a branch, and the branch file holds the commit."""
        self.write(".git/HEAD", "ref: refs/heads/main\n")
        self.write(".git/refs/heads/main", "a" * 40 + "\n")
        self.assertEqual(LocalContent(self.checkout).revision(), "a" * 40)

    def test_a_detached_head_is_the_revision_itself(self):
        """A detached HEAD holds the commit id itself."""
        self.write(".git/HEAD", "b" * 40 + "\n")
        self.assertEqual(LocalContent(self.checkout).revision(), "b" * 40)

    def test_a_reference_with_no_file_reports_no_revision(self):
        """A packed ref: resolving it properly would mean parsing packed-refs, and an
        unknown revision is a better answer than a wrong one."""
        self.write(".git/HEAD", "ref: refs/heads/packed\n")
        self.assertEqual(LocalContent(self.checkout).revision(), "")

    # --- listing -----------------------------------------------------------
    def test_every_file_is_listed_by_its_path_relative_to_the_checkout(self):
        """Every file is listed by its path relative to the checkout."""
        listed: List[str] = self.content.list_paths()
        self.assertIn("registries/aaosa.hocon", listed)
        self.assertIn("neuro_san_studio/toolbox/toolbox_info.hocon", listed)
        self.assertIn("coded_tools/web_fetch.py", listed)

    def test_the_listing_is_flat_and_holds_no_directories(self):
        """Resolution matches paths against this list, so a directory entry in it
        would be something a build could try to read."""
        for path in self.content.list_paths():
            with self.subTest(path=path):
                self.assertTrue((self.checkout / path).is_file())

    def test_a_virtualenv_and_its_kind_are_not_studio_content(self):
        """Listing them would be slow and would offer a build files it must never
        resolve an include to."""
        self.write("venv/lib/coded_tools/only_in_venv.py", "")
        self.write("node_modules/pkg/index.js", "")
        self.write("coded_tools/__pycache__/web_fetch.cpython-312.pyc", "")
        listed: List[str] = LocalContent(self.checkout).list_paths()
        for unwanted in ("venv", "node_modules", "__pycache__"):
            with self.subTest(unwanted=unwanted):
                self.assertFalse([path for path in listed if unwanted in path])

    def test_hidden_directories_are_not_studio_content(self):
        """Which is what keeps .git out of the listing."""
        self.write(".git/HEAD", "ref: refs/heads/main\n")
        self.write(".github/workflows/ci.yml", "")
        listed: List[str] = LocalContent(self.checkout).list_paths()
        self.assertFalse([path for path in listed if path.startswith(".")])

    def test_a_missing_checkout_is_an_error_rather_than_an_empty_studio(self):
        """os.walk answers nothing for a directory that is not there, which would read
        as a studio holding no files — and a build would then report every include as
        missing instead of the checkout."""
        missing: LocalContent = LocalContent(self.checkout / "nowhere")
        with self.assertRaises(FileNotFoundError):
            missing.list_paths()

    # --- reading -----------------------------------------------------------
    def test_a_file_is_read_as_bytes(self):
        """Bytes, not text: a source is the wrong place to decide an encoding."""
        self.assertEqual(self.content.read("coded_tools/web_fetch.py"), b"VALUE = 1\n")

    def test_a_file_the_checkout_does_not_have_reads_as_none(self):
        """A file the checkout does not have reads as None."""
        self.assertIsNone(self.content.read("registries/absent.hocon"))

    def test_an_edit_in_the_checkout_is_visible_to_the_next_read(self):
        """The property a developer wants from a local studio: change a file, build
        again, see the change. It is why nothing is copied here."""
        self.write("registries/aaosa.hocon", '{"edited": true}')
        self.assertEqual(self.content.read("registries/aaosa.hocon"), b'{"edited": true}')

    def test_a_path_leaving_the_checkout_reads_as_none(self):
        """list_paths never reports one, but read takes a string from a caller, and a
        studio must not become a way to read the rest of the filesystem."""
        secret: Path = self.checkout.parent / "secret.txt"
        secret.write_text("fake-secret", encoding="utf-8")
        self.addCleanup(secret.unlink)
        self.assertIsNone(self.content.read("../secret.txt"))

    def test_a_symbolic_link_out_of_the_checkout_reads_as_none(self):
        """The same rule, by the route that a listing could actually report."""
        secret: Path = self.checkout.parent / "linked-secret.txt"
        secret.write_text("fake-secret", encoding="utf-8")
        self.addCleanup(secret.unlink)
        (self.checkout / "registries" / "leak.hocon").symlink_to(secret)
        self.assertIsNone(self.content.read("registries/leak.hocon"))


if __name__ == "__main__":
    unittest.main()
