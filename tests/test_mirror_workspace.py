import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Dict
from typing import List
from typing import Optional

from typing_extensions import override

from nsdeploy.interfaces.toolbox_content import ToolboxContent
from nsdeploy.studio_content.empty_content import EmptyContent
from nsdeploy.studio_content.local_content import LocalContent
from nsdeploy.studio_content.mirror_workspace import MirrorWorkspace


class _Content(ToolboxContent):
    """A toolbox held in a dictionary, which is the whole point of the seam.

    A workspace that can be driven by this reads nothing but its content source, so
    a test can state a layout outright instead of building one on disk.
    """

    def __init__(self, files: Dict[str, bytes]) -> None:
        """
        Hold a toolbox made of `files`.

        :param files: The file content, by the source's own path.
        """
        self.files: Dict[str, bytes] = files
        self.listings: int = 0
        self.broken: bool = False

    @override
    def identity(self) -> str:
        """
        :return: A fixed name.
        """
        return "fake:studio"

    @override
    def revision(self) -> str:
        """
        :return: A fixed revision.
        """
        return "r1"

    @override
    def list_paths(self) -> List[str]:
        """
        :return: The paths held, counting how often the workspace asked.
        :raises OSError: When this source is set to fail.
        """
        self.listings += 1
        if self.broken:
            raise OSError("cannot list")
        return list(self.files.keys())

    @override
    def read(self, path: str) -> Optional[bytes]:
        """
        :param path: A path exactly as `list_paths` returned it.
        :return: The file's bytes, or None when there is no such file.
        """
        return self.files.get(path)


# pylint: disable-next=too-many-public-methods  # one test per behaviour of an eight-method interface
class TestMirrorWorkspace(unittest.TestCase):
    """A workspace written once over any content source.

    What these tests pin is `ToolboxWorkspace`'s contract: which source path a logical
    path resolves to, that a materialized file lands at the *logical* path, that a
    file the toolbox has dropped does not survive in the mirror, and that a network's
    own include cannot write outside the directory the workspace was given.
    """

    def setUp(self) -> None:
        """
        Give each test an empty mirror and a studio-shaped content source.
        """
        # The mirror sits inside a directory of its own, so a test that checks nothing
        # was written beside it looks at a directory this test owns rather than at the
        # system temporary directory, which everything else shares.
        self.base: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.base)
        self.mirror: Path = self.base / "mirror"
        self.mirror.mkdir()
        self.content: _Content = _Content({
            "registries/aaosa.hocon": b"{}",
            "coded_tools/web_fetch.py": b"VALUE = 1\n",
        })
        self.workspace: MirrorWorkspace = MirrorWorkspace(self.content, self.mirror)

    # --- identity and directories -----------------------------------------
    def test_the_identity_is_the_content_sources(self):
        """A reader needs the toolbox named, not the mirror it was copied into."""
        self.assertEqual(self.workspace.identity(), "fake:studio")

    def test_the_include_base_is_the_mirror(self):
        """It is what pyhocon parses a network against."""
        self.assertEqual(self.workspace.include_base(), self.mirror)

    def test_the_import_root_is_the_mirror(self):
        """It is what goes on sys.path, and a coded tool sits in a package under it."""
        self.assertEqual(self.workspace.import_root(), self.mirror)

    # --- fetch -------------------------------------------------------------
    def test_fetching_prepares_the_listing(self):
        """The call a trusted process makes once, so no build pays for it first."""
        self.assertTrue(self.workspace.fetch())
        self.assertEqual(self.content.listings, 1)

    def test_the_listing_is_asked_for_once_per_workspace(self):
        """Over a network source it is the expensive question."""
        self.workspace.fetch()
        self.workspace.resolve("registries/aaosa.hocon")
        self.workspace.resolve("coded_tools/web_fetch.py")
        self.assertEqual(self.content.listings, 1)

    def test_forcing_a_fetch_asks_the_source_again(self):
        """Which is how a caller picks up a toolbox that has changed."""
        self.workspace.fetch()
        self.workspace.fetch(force=True)
        self.assertEqual(self.content.listings, 2)

    def test_a_source_that_cannot_be_listed_reports_rather_than_raises(self):
        """Best effort by contract: a caller carries on, and the next build that needs
        a path asks again."""
        self.content.broken = True
        self.assertFalse(self.workspace.fetch())

    # --- resolution --------------------------------------------------------
    def test_a_path_the_toolbox_holds_outright_resolves_to_itself(self):
        """A path the toolbox holds outright resolves to itself."""
        self.assertEqual(self.workspace.resolve("registries/aaosa.hocon"), "registries/aaosa.hocon")

    def test_a_nested_copy_is_found_by_the_path_a_network_asks_for(self):
        """A network names `registries/aaosa.hocon`; a toolbox may keep it under its
        own package directory."""
        nested: _Content = _Content({"neuro_san_studio/registries/aaosa.hocon": b"{}"})
        workspace: MirrorWorkspace = MirrorWorkspace(nested, self.mirror)
        self.assertEqual(workspace.resolve("registries/aaosa.hocon"),
                         "neuro_san_studio/registries/aaosa.hocon")

    def test_the_least_nested_copy_wins(self):
        """A toolbox that vendors a second copy deeper in its tree must not shadow the
        canonical one."""
        many: _Content = _Content({
            "vendor/third_party/neuro_san_studio/registries/aaosa.hocon": b"deep",
            "neuro_san_studio/registries/aaosa.hocon": b"canonical",
        })
        workspace: MirrorWorkspace = MirrorWorkspace(many, self.mirror)
        self.assertEqual(workspace.resolve("registries/aaosa.hocon"),
                         "neuro_san_studio/registries/aaosa.hocon")

    def test_a_file_name_resolves_when_no_directory_matches(self):
        """The last fallback: a toolbox that arranges its registries differently still
        answers for the file a network named."""
        moved: _Content = _Content({"configs/aaosa.hocon": b"{}"})
        workspace: MirrorWorkspace = MirrorWorkspace(moved, self.mirror)
        self.assertEqual(workspace.resolve("registries/aaosa.hocon"), "configs/aaosa.hocon")

    def test_a_file_the_toolbox_does_not_hold_resolves_to_none(self):
        """A file the toolbox does not hold resolves to None."""
        self.assertIsNone(self.workspace.resolve("registries/absent.hocon"))

    # --- reading -----------------------------------------------------------
    def test_a_file_is_read_as_text_without_touching_the_mirror(self):
        """For everything parsed rather than included, so a reader need not
        materialize to look."""
        self.assertEqual(self.workspace.read_text("registries/aaosa.hocon"), "{}")
        self.assertEqual(list(self.mirror.iterdir()), [])

    def test_reading_follows_the_same_resolution_as_materializing(self):
        """Otherwise a network could be parsed from one copy and built from another."""
        nested: _Content = _Content({"neuro_san_studio/registries/aaosa.hocon": b'{"nested": true}'})
        workspace: MirrorWorkspace = MirrorWorkspace(nested, self.mirror)
        self.assertEqual(workspace.read_text("registries/aaosa.hocon"), '{"nested": true}')

    def test_a_file_the_toolbox_does_not_hold_reads_as_none(self):
        """A file the toolbox does not hold reads as None."""
        self.assertIsNone(self.workspace.read_text("registries/absent.hocon"))

    def test_a_file_that_is_not_text_is_reported_rather_than_mangled(self):
        """Replacing undecodable bytes would hand pyhocon a file that is not what the
        toolbox holds."""
        binary: _Content = _Content({"registries/aaosa.hocon": b"\xff\xfe\x00"})
        workspace: MirrorWorkspace = MirrorWorkspace(binary, self.mirror)
        with self.assertRaises(UnicodeDecodeError):
            workspace.read_text("registries/aaosa.hocon")

    # --- materializing -----------------------------------------------------
    def test_a_materialized_file_lands_under_the_mirror(self):
        """A materialized file lands under the mirror."""
        local: Optional[Path] = self.workspace.materialize("registries/aaosa.hocon")
        self.assertEqual(local, self.mirror / "registries/aaosa.hocon")
        self.assertEqual(local.read_bytes(), b"{}")

    def test_a_file_is_mirrored_at_the_logical_path_not_the_sources(self):
        """An included file names its siblings the way the network does, so pyhocon
        has to find them under the names the network uses."""
        nested: _Content = _Content({"neuro_san_studio/registries/aaosa.hocon": b"{}"})
        workspace: MirrorWorkspace = MirrorWorkspace(nested, self.mirror)
        workspace.materialize("registries/aaosa.hocon")
        self.assertTrue((self.mirror / "registries/aaosa.hocon").is_file())
        self.assertFalse((self.mirror / "neuro_san_studio").exists())

    def test_a_file_the_toolbox_has_dropped_does_not_survive_in_the_mirror(self):
        """A copy from an earlier build must not satisfy an include the toolbox no
        longer holds."""
        mirrored: Path = self.mirror / "registries/aaosa.hocon"
        self.workspace.materialize("registries/aaosa.hocon")
        self.content.files.pop("registries/aaosa.hocon")
        self.workspace.fetch(force=True)
        self.assertIsNone(self.workspace.materialize("registries/aaosa.hocon"))
        self.assertFalse(mirrored.exists())

    def test_a_path_leaving_the_mirror_is_refused(self):
        """A logical path comes from a network's own include lines, so it is input."""
        escaped: Path = self.base / "escaped.hocon"
        self.content.files["escaped.hocon"] = b"{}"
        self.workspace.fetch(force=True)
        self.assertIsNone(self.workspace.materialize("../escaped.hocon"))
        self.assertFalse(escaped.exists())

    # --- coded tools -------------------------------------------------------
    def test_a_coded_tool_is_written_inside_an_importable_package(self):
        """Python imports a module through its package, so the marker is part of the
        job rather than someone else's."""
        self.assertTrue(self.workspace.ensure_coded_tool("web_fetch.py"))
        self.assertTrue((self.mirror / "coded_tools/__init__.py").is_file())
        self.assertEqual((self.mirror / "coded_tools/web_fetch.py").read_bytes(), b"VALUE = 1\n")

    def test_the_package_marker_is_written_even_when_the_tool_is_absent(self):
        """An empty coded_tools package is harmless; a module without one is
        unreachable, and the next tool found would then need the marker anyway."""
        self.assertFalse(self.workspace.ensure_coded_tool("absent.py"))
        self.assertTrue((self.mirror / "coded_tools/__init__.py").is_file())

    # --- over a real content source ----------------------------------------
    def test_the_workspace_reads_a_local_checkout_through_the_same_seam(self):
        """The workspace is written once over any ToolboxContent, so a checkout needs
        no code of its own here."""
        checkout: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, checkout)
        (checkout / "neuro_san_studio" / "registries").mkdir(parents=True)
        (checkout / "neuro_san_studio" / "registries" / "aaosa.hocon").write_text("{}", encoding="utf-8")
        workspace: MirrorWorkspace = MirrorWorkspace(LocalContent(checkout), self.mirror)
        self.assertEqual(workspace.identity(), str(checkout))
        self.assertEqual(workspace.read_text("registries/aaosa.hocon"), "{}")
        self.assertEqual(workspace.materialize("registries/aaosa.hocon"),
                         self.mirror / "registries/aaosa.hocon")

    def test_a_workspace_over_an_empty_toolbox_answers_rather_than_fails(self):
        """A self-contained network has no external toolbox, and the build takes the
        same path it takes over a checkout — it just resolves nothing."""
        workspace: MirrorWorkspace = MirrorWorkspace(EmptyContent(), self.mirror)
        self.assertTrue(workspace.fetch())
        self.assertIsNone(workspace.resolve("registries/aaosa.hocon"))
        self.assertIsNone(workspace.read_text("registries/aaosa.hocon"))
        self.assertIsNone(workspace.materialize("registries/aaosa.hocon"))
        self.assertFalse(workspace.ensure_coded_tool("web_fetch.py"))


if __name__ == "__main__":
    unittest.main()
