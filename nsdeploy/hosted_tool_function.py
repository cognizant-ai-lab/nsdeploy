import inspect
import json
from typing import Any, Dict, List


class HostedToolFunction:
    """
    Async callable that FastMCP hosts as one MCP tool. Its `__signature__` mirrors
    the tool's JSON-Schema parameters, so FastMCP advertises a correct inputSchema,
    and a call forwards the supplied arguments to the coded tool. The signature is
    built with `inspect` rather than generated source, so parameter names must be
    identifiers.
    """

    JSON_TO_PY: Dict[str, type] = {"string": str, "integer": int, "number": float,
                                   "boolean": bool, "array": list, "object": dict}

    def __init__(self, coded: Any, name: str, description: str, parameters: Dict[str, Any]):
        """
        Constructor.

        :param coded: The coded tool instance to call
        :param name: MCP tool name, which FastMCP reads from `__name__`
        :param description: MCP tool description, which FastMCP reads from `__doc__`
        :param parameters: JSON-Schema object that describes the tool's arguments
        :raises ValueError: When a parameter name is not an identifier
        """
        self.__name__: str = name
        self.__doc__: str = description
        self.coded: Any = coded
        self.use_async: bool = HostedToolFunction.uses_async(coded)
        self.__signature__: inspect.Signature = HostedToolFunction.build_signature(parameters)

    @staticmethod
    def uses_async(coded: Any) -> bool:
        """
        Decide whether the coded tool is called through `async_invoke` or `invoke`.

        :param coded: The coded tool instance
        :return: True when the tool overrides `async_invoke`
        """
        try:
            # pylint: disable=import-outside-toplevel
            from neuro_san.interfaces.coded_tool import CodedTool
            return type(coded).async_invoke is not CodedTool.async_invoke
        except (ImportError, AttributeError):
            return hasattr(coded, "async_invoke") and not hasattr(coded, "invoke")

    @staticmethod
    def build_signature(parameters: Dict[str, Any]) -> inspect.Signature:
        """
        Build a keyword-only signature from a JSON-Schema object.

        :param parameters: JSON-Schema object that describes the tool's arguments
        :return: The signature, with required properties lacking a default
        :raises ValueError: When a property name is not an identifier
        """
        props: Dict[str, Any] = (parameters or {}).get("properties", {}) or {}
        required: set = set((parameters or {}).get("required", []) or [])
        sig_params: List[inspect.Parameter] = []
        pname: str = None
        pdef: Dict[str, Any] = None
        # Add one keyword-only parameter per schema property.
        for pname, pdef in props.items():
            ann: type = HostedToolFunction.JSON_TO_PY.get((pdef or {}).get("type"), str)
            default: Any = inspect.Parameter.empty if pname in required else None
            # inspect.Parameter raises ValueError for a name that is not an identifier.
            sig_params.append(inspect.Parameter(pname, inspect.Parameter.KEYWORD_ONLY, default=default, annotation=ann))
        return inspect.Signature(sig_params, return_annotation=str)

    async def __call__(self, **kwargs: Any) -> str:
        """
        Call the coded tool with the arguments the MCP client supplied.

        :param kwargs: Tool arguments; unset optional arguments arrive as None
        :return: The tool result, JSON-encoded unless it is already a string
        """
        args: Dict[str, Any] = {}
        name: str = None
        value: Any = None
        # Drop unset optional arguments.
        for name, value in kwargs.items():
            if value is not None:
                args[name] = value
        if self.use_async:
            result: Any = await self.coded.async_invoke(args, {})
        else:
            result = self.coded.invoke(args, {})
        return result if isinstance(result, str) else json.dumps(result, default=str)
