from pathlib import Path


class CailvilleMap:
    """
    Locates the Cailville community map that the demo reads.

    The active map, ``community.json``, is local git-ignored state that the first site addition
    creates. Until it exists, the checked-in ``community.base.json`` is the active map.
    """

    @staticmethod
    def active_path(cailville_dir: Path) -> Path:
        """
        Return the path of the active community map.

        :param cailville_dir: Directory that holds the Cailville map files
        :return: ``community.json`` when it exists, otherwise ``community.base.json``
        """
        active: Path = cailville_dir / "community.json"
        if active.is_file():
            return active
        return cailville_dir / "community.base.json"
