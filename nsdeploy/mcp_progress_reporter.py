from typing import Any
from typing import Dict


class McpProgressReporter:
    """
    neuro-san's AgentProgressReporter for a hosted tool. Each report is an MCP log
    notification tied to the tool call, so it reaches the caller before the result.
    """

    def __init__(self, context: Any, tool_name: str):
        """
        Constructor.

        :param context: FastMCP Context of the tool call the reports belong to
        :param tool_name: Tool name, sent as the logger of each notification
        """
        self.context: Any = context
        self.tool_name: str = tool_name

    async def async_report_progress(self, structure: Dict[str, Any], content: str = "") -> None:
        """
        Send one progress report to the MCP caller as a log notification.

        :param structure: Progress data, for example {"progress": 0.5}
        :param content: Optional message, added as "message" unless the data already has one
        """
        data: Dict[str, Any] = dict(structure or {})
        if content and "message" not in data:
            data["message"] = content
        await self.context.session.send_log_message(
            level="info", data=data, logger=self.tool_name, related_request_id=self.context.request_id)
