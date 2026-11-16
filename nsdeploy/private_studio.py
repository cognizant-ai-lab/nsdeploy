"""Launch a standard Neuro-SAN studio with nsdeploy coded tools available.

The studio's ``run.py`` intentionally resets ``PYTHONPATH`` to its own checkout.
Generated private stewards use ``nsdeploy.steward``; this wrapper preserves the
studio behavior while adding the nsdeploy project back to the import path.
"""
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any
from typing import Callable
from typing import Optional


def _installed_cli_args(argv: list[str]) -> list[str]:
    """Translate the launcher's common flags to the installed studio CLI.

    The packaged CLI gets its gRPC port from the environment and does not have
    the legacy ``--server-grpc-port`` or ``--no-html`` options.
    """
    translated: list[str] = []
    skip_next: bool = False
    argument: str
    for argument in argv:
        if skip_next:
            skip_next = False
            continue
        if argument == "--no-html":
            continue
        if argument == "--server-grpc-port":
            skip_next = True
            continue
        if argument.startswith("--server-grpc-port="):
            continue
        translated.append(argument)
    return translated


def main() -> int:
    """
    Run the private Neuro-SAN studio with nsdeploy added to the child PYTHONPATH.

    :return: The process exit code.
    :raises SystemExit: If the studio project or its runner cannot be found or loaded.
    """
    studio_root: Path = Path(os.environ.get("NSDEPLOY_PRIVATE_STUDIO_ROOT", "")).resolve()
    if not studio_root.is_dir():
        raise SystemExit(f"Private Neuro-SAN studio project not found: {studio_root}")
    sys.path.insert(0, str(studio_root))
    os.chdir(studio_root)

    run_file: Optional[Path] = next((candidate for candidate in (
        studio_root / "run.py",
        studio_root / "neuro_san_studio" / "run.py",
        studio_root / "neuro-san-studio" / "run.py",
        studio_root.parent / "run.py",
    ) if candidate.is_file()), None)
    # Recent neuro-san-studio releases are installed as a package and expose
    # a Typer CLI instead of the old top-level run.py module.
    if run_file is None:
        command: list[str] = [
            sys.executable,
            "-m",
            "neuro_san_studio",
            "run",
            *_installed_cli_args(sys.argv[1:]),
        ]
        os.execvpe(sys.executable, command, os.environ)
        raise AssertionError("execvpe returned unexpectedly")

    spec: Optional[importlib.machinery.ModuleSpec] = importlib.util.spec_from_file_location("run", run_file)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Could not load Neuro-SAN studio runner: {run_file}")
    studio_run: ModuleType = importlib.util.module_from_spec(spec)
    sys.modules["run"] = studio_run
    spec.loader.exec_module(studio_run)

    original_set_environment: Callable[[Any], None] = studio_run.NeuroSanRunner.set_environment_variables

    def set_environment_with_nsdeploy(self: Any) -> None:
        original_set_environment(self)
        project_root: str = str(Path(__file__).resolve().parents[1])
        current: str = os.environ.get("PYTHONPATH", "")
        os.environ["PYTHONPATH"] = os.pathsep.join(
            item for item in (project_root, current) if item
        )

    studio_run.NeuroSanRunner.set_environment_variables = set_environment_with_nsdeploy
    studio_run.NeuroSanRunner().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
