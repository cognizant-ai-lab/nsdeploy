import json
from pathlib import Path
from typing import Any, Dict


class SiteManifest:
    """
    Reads values from a deployed site's `agent-manifest.json`, which sits next to
    each `<network>.network.json` in the site directory.
    """

    FILE_NAME: str = "agent-manifest.json"

    @staticmethod
    def front_man(config_path: Path) -> str:
        """
        Read the front-man of the network in `config_path` from the site's agent-manifest.json.

        :param config_path: Path of the site's `<network>.network.json`
        :return: The front-man agent name listed for that network
        :raises ValueError: When the manifest lists no front-man for the network
        """
        manifest_path: Path = config_path.parent / SiteManifest.FILE_NAME
        manifest: Dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry: Dict[str, Any] = None
        # Find the manifest entry for this network.
        for entry in manifest.get("networks", []) or []:
            if f"{entry.get('name')}.network.json" == config_path.name and isinstance(entry.get("front_man"), str):
                return entry.get("front_man")
        raise ValueError(f"{manifest_path} names no front-man for {config_path.name}")
