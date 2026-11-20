import argparse
import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from typing import Dict
from typing import List
from unittest import mock

from nsbundle.nsbundle import NsBundle

SELF_CONTAINED: str = """
{
    "tools": [
        {
            "name": "concierge",
            "function": {"description": "Answer questions about the shop."},
            "instructions": "You are a helpful shop concierge. Answer briefly."
        }
    ]
}
"""

# A network that needs a file from the toolbox, and names one Python tool.
INCLUDING: str = """
include "registries/shop_common.hocon"
"tools": [
    {
        "name": "concierge",
        "function": {"description": "Answer questions about the shop."},
        "instructions": ${shop_instructions},
        "tools": ["stock"]
    },
    {
        "name": "stock",
        "function": {"description": "Look up stock."},
        "class": "stock_tool.StockTool"
    }
]
"""


class TestNsBundle(unittest.TestCase):
    """The nsbundle command line and the build behind it.

    The end-to-end tests use a self-contained network and `--no-studio`, so a build
    reaches no checkout and no network: what they exercise is nsbundle's own wiring
    of nsdeploy's resolve, plan and generate.
    """

    def setUp(self) -> None:
        """
        Create a network to bundle, and a home directory no other test shares.
        """
        self.base: Path = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.base)
        self.hocon: Path = self.base / "solo.hocon"
        self.hocon.write_text(SELF_CONTAINED, encoding="utf-8")
        self.out: Path = self.base / "bundle"
        # Every mirror and cache lives under the invoking user's home, which a test must
        # not write to.
        self.home: Path = self.base / "home"
        patcher = mock.patch.object(Path, "home", return_value=self.home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_checkout(self) -> Path:
        """
        Create a studio checkout holding the file `INCLUDING` needs.

        :return: The checkout.
        """
        checkout: Path = self.base / "studio"
        common: Path = checkout / "registries" / "shop_common.hocon"
        common.parent.mkdir(parents=True)
        common.write_text('shop_instructions = "You are a helpful shop concierge."\n', encoding="utf-8")
        return checkout

    @staticmethod
    def quietly(argv: List[str]) -> tuple[int, str]:
        """
        Run nsbundle and keep what it prints.

        :param argv: The command line.
        :return: The exit code and the standard output.
        """
        printed: io.StringIO = io.StringIO()
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
            code: int = NsBundle.main(argv)
        return code, printed.getvalue()

    def run_bundle(self, *extra: str) -> int:
        """
        Build the test network, with `--no-studio` and no discovery.

        :param extra: Further command-line arguments.
        :return: The exit code.
        """
        argv = [str(self.hocon), "--no-studio", "--no-action-discovery", "--out", str(self.out)]
        argv.extend(extra)
        return NsBundle.main(argv)

    # --- the command line --------------------------------------------------
    def test_the_defaults_are_nsdeploys(self) -> None:
        """A caller moving from `nsdeploy --static-bundle` must not get a different
        repository, ref or BYOK upstream by saying nothing."""
        args: argparse.Namespace = NsBundle.parse([str(self.hocon)])
        self.assertEqual(args.repo, "cognizant-ai-lab/neuro-san-studio")
        self.assertEqual(args.ref, "main")
        self.assertEqual(args.upstream, "https://api.openai.com/v1")

    def test_serving_options_are_absent_rather_than_ignored(self) -> None:
        """A bundle is files. An option that could only affect a served site has no
        meaning here, and silently accepting it would be worse than refusing it."""
        for absent in ("--port", "--no-serve", "--theme", "--site-dir", "--facade-upstream"):
            with self.subTest(absent=absent):
                with self.assertRaises(SystemExit):
                    NsBundle.parse([str(self.hocon), absent, "8080"])

    def test_two_toolboxes_cannot_be_asked_for_at_once(self) -> None:
        """--no-studio and --studio describe different builds."""
        with self.assertRaises(SystemExit):
            NsBundle.parse([str(self.hocon), "--no-studio", "--studio", str(self.base)])

    def test_an_adapter_that_is_not_there_is_refused(self) -> None:
        """It is copied into the bundle, so a typo must not reach generation."""
        with self.assertRaises(SystemExit):
            NsBundle.parse([str(self.hocon), "--actions", str(self.base / "absent.js")])

    def test_the_output_directory_defaults_below_the_working_directory(self) -> None:
        """A bundle is disposable build output, so it does not land beside the HOCON."""
        args: argparse.Namespace = NsBundle.parse([str(self.hocon)])
        where: Path = NsBundle.output_dir(args, self.hocon, "solo")
        self.assertEqual(where, Path.cwd() / ".nsbundle" / self.base.name / "solo")

    def test_a_named_output_directory_wins(self) -> None:
        """A named output directory wins."""
        args: argparse.Namespace = NsBundle.parse([str(self.hocon), "--out", str(self.out)])
        self.assertEqual(NsBundle.output_dir(args, self.hocon, "solo"), self.out)

    # --- building ----------------------------------------------------------
    def test_a_network_that_needs_no_toolbox_bundles(self) -> None:
        """The whole point of the tool, and of the empty content source behind it."""
        self.assertEqual(self.run_bundle(), 0)
        self.assertTrue((self.out / "index.html").is_file())
        self.assertTrue((self.out / "solo.network.json").is_file())

    def test_the_bundle_is_self_contained(self) -> None:
        """It is served by a static host, so the runtime and the manifests travel with
        it and nothing waits on a server."""
        self.run_bundle()
        for expected in ("runtime", "agent-manifest.json", "agent-mcp.json",
                         ".well-known/nsdeploy-agent.json", "theme.css", "site.js"):
            with self.subTest(expected=expected):
                self.assertTrue((self.out / expected).exists())

    def test_no_private_steward_is_written(self) -> None:
        """A steward is an operator-side Neuro-SAN configuration, not a browser asset."""
        self.run_bundle()
        self.assertEqual(list(self.out.glob("*steward*")), [])
        self.assertFalse((self.out.parent / "manifest.hocon").exists())

    def test_the_runtime_calls_the_model_directly(self) -> None:
        """There is no server to proxy through, so the BYOK upstream is baked in as
        given rather than rewritten to a same-origin route."""
        self.run_bundle("--upstream", "https://example.test/v1")
        manifest: Dict[str, Any] = json.loads((self.out / "agent-manifest.json").read_text(encoding="utf-8"))
        self.assertIn("https://example.test/v1", json.dumps(manifest))

    def test_a_hocon_that_is_not_there_is_an_error(self) -> None:
        """Reported, rather than raised at the caller."""
        code, printed = TestNsBundle.quietly([str(self.base / "absent.hocon"), "--no-studio"])
        self.assertEqual(code, 2)
        self.assertIn("HOCON not found", printed)

    def test_includes_are_resolved_from_a_local_checkout(self) -> None:
        """The toolbox comes through nsdeploy's own workspace, mirrored under the
        same cache nsdeploy uses."""
        including: Path = self.base / "shop.hocon"
        including.write_text(INCLUDING, encoding="utf-8")
        code, printed = TestNsBundle.quietly([str(including), "--studio", str(self.make_checkout()),
                                              "--no-action-discovery", "--out", str(self.out)])
        self.assertEqual(code, 0, printed)
        network: str = (self.out / "shop.network.json").read_text(encoding="utf-8")
        self.assertIn("You are a helpful shop concierge.", network)
        mirrors: List[Path] = list((self.home / ".cache" / "nsdeploy").glob("local_studio_*"))
        self.assertEqual(len(mirrors), 1)

    def test_python_tools_are_omitted_without_being_imported(self) -> None:
        """A static bundle runs no Python, so a build must not import or install a
        coded tool to find out whether it could host it."""
        including: Path = self.base / "shop.hocon"
        including.write_text(INCLUDING, encoding="utf-8")
        refuse: mock.MagicMock = mock.MagicMock(side_effect=AssertionError("imported a coded tool"))
        with mock.patch("nsdeploy.resolve._import_with_autoinstall", refuse):
            code, printed = TestNsBundle.quietly([str(including), "--studio", str(self.make_checkout()),
                                                  "--no-action-discovery", "--out", str(self.out)])
        self.assertEqual(code, 0, printed)
        self.assertIn("omitted Python tools: stock", printed)
        refuse.assert_not_called()

    def test_a_network_whose_include_is_missing_is_an_error(self) -> None:
        """Without a toolbox the include cannot resolve, and the caller gets a message
        rather than a traceback."""
        including: Path = self.base / "shop.hocon"
        including.write_text(INCLUDING, encoding="utf-8")
        code, printed = TestNsBundle.quietly([str(including), "--no-studio", "--no-action-discovery",
                                              "--out", str(self.out)])
        self.assertEqual(code, 2)
        self.assertIn("the HOCON could not be resolved", printed)

    def test_a_network_that_cannot_be_resolved_is_an_error(self) -> None:
        """pyhocon reports a bad network through its own exceptions; a caller gets a
        message about the file they passed, not a traceback."""
        broken: Path = self.base / "broken.hocon"
        broken.write_text('{"tools": [{"name": "a", "instructions": ${missing}}]}', encoding="utf-8")
        args: argparse.Namespace = NsBundle.parse([str(broken), "--no-studio"])
        self.assertEqual(NsBundle.build(args), 2)

    def test_a_network_with_no_front_man_is_an_error(self) -> None:
        """The generated page would have nothing to talk to."""
        leafless: Path = self.base / "leafless.hocon"
        leafless.write_text('{"tools": [{"name": "t", "class": "pkg.mod.Tool"}]}', encoding="utf-8")
        args: argparse.Namespace = NsBundle.parse([str(leafless), "--no-studio", "--no-action-discovery",
                                                   "--out", str(self.out)])
        self.assertEqual(NsBundle.build(args), 2)


if __name__ == "__main__":
    unittest.main()
