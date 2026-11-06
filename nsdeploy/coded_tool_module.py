from pathlib import Path
from typing import Optional


class CodedToolModule:
    """
    Maps a coded-tool module name onto a file that exists under a studio's
    `coded_tools` package. The importable name is built from the directory listing,
    never from the requested text, so a HOCON or spec value cannot select an
    arbitrary module.
    """

    PACKAGE: str = "coded_tools"

    @staticmethod
    def find(studio_root: Path, module_leaf: str) -> Optional[str]:
        """
        Find the importable name of `coded_tools/<module_leaf>.py` under `studio_root`.

        :param studio_root: Root directory that holds the `coded_tools` package
        :param module_leaf: File name of the module, without the `.py` suffix
        :return: The dotted module name, or None when no such file exists
        """
        if not isinstance(module_leaf, str) or not module_leaf.isidentifier():
            return None
        package_dir: Path = Path(studio_root) / CodedToolModule.PACKAGE
        if not package_dir.is_dir():
            return None
        candidate: Path = None
        # Use the listed file's own stem as the module name.
        for candidate in package_dir.iterdir():
            if candidate.suffix == ".py" and candidate.is_file() and candidate.stem == module_leaf:
                return f"{CodedToolModule.PACKAGE}.{candidate.stem}"
        return None

    @staticmethod
    def find_dotted(studio_root: Path, module: str) -> Optional[str]:
        """
        Find the importable name for a full `coded_tools.<leaf>` module name.

        :param studio_root: Root directory that holds the `coded_tools` package
        :param module: Dotted module name, which must be `coded_tools.<leaf>`
        :return: The dotted module name, or None when it is not a studio coded tool
        """
        if not isinstance(module, str):
            return None
        package, _, module_leaf = module.partition(".")
        if package != CodedToolModule.PACKAGE:
            return None
        return CodedToolModule.find(studio_root, module_leaf)
