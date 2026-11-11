from typing import Tuple


class NssLayout:
    """The paths and names nsdeploy expects a neuro-san-studio to publish.

    These four strings are the whole of the naming contract between nsdeploy and NSS.
    They were literals spread across resolve.py, mcp_host.py, coded_tool_module.py and
    studio.py, which made the contract impossible to see and impossible to vary: a
    source that organizes its files differently had nothing to override.

    A logical path is what an agent network asks for, such as
    `registries/aaosa.hocon`. It is not necessarily where the source keeps the file —
    resolving one to the other is `NssContent`'s business, not this class's.
    """

    # The package of Python coded tools. nsdeploy imports from it by name, so this is
    # also the import prefix a hosted tool is reached under.
    CODED_TOOLS: str = "coded_tools"

    # The catalogue of toolbox entries a network may name instead of a class path.
    TOOLBOX_INFO: str = "toolbox/toolbox_info.hocon"

    # Where shared agent-network definitions live, which a network includes by path.
    REGISTRIES: str = "registries"

    # The package directory a studio checkout may nest its sources under. Only a hint
    # for resolution: a source is not required to use it.
    STUDIO_PACKAGE: str = "neuro_san_studio"

    # Suffixes a logical path may carry. Anything else is not studio content, which is
    # what lets a source reject a request without reading it.
    CONTENT_SUFFIXES: Tuple[str, ...] = (".hocon", ".conf", ".json", ".py")

    @staticmethod
    def coded_tool_path(module_file: str) -> str:
        """
        The logical path of one coded-tool module.

        :param module_file: The module's file name, such as `web_fetch.py`.
        :return: The logical path to ask a source for.
        """
        return f"{NssLayout.CODED_TOOLS}/{module_file}"
