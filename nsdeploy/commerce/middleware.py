"""Private-chat confirmation and canonical commerce responses for Neuro-SAN."""
import re
import secrets
from decimal import Decimal

from langchain.agents.middleware.types import AgentMiddleware, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage

from .steward import TURN, PrivateTurn, binding_for, start_binding


def confirms_booking(text):
    """
    Report whether a chat message confirms the presented booking offer.

    :param text: The user's chat message.
    :return: True when the message is a booking confirmation.
    """
    return bool(re.fullmatch(
        r"\s*(?:yes[,! .]*\s*)?(?:please\s+)?(?:confirm(?:\s+(?:the\s+)?(?:booking|reservation|offer))?|"
        r"book\s+it|approve(?:\s+(?:it|the\s+offer))?|go\s+ahead(?:\s+and\s+book\s+it)?|proceed)\s*[.!]*\s*",
        text, re.IGNORECASE))


def budget_from_text(text):
    """
    Extract the last dollar amount stated in a chat message.

    :param text: The user's chat message.
    :return: The amount in USD cents, or None when no amount is stated.
    """
    matches = list(re.finditer(r"(?:\$|USD\s*)(\d[\d,]*(?:\.\d{1,2})?)(?!\d|\.\d)|"
                               r"(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|USD)\b", text, re.IGNORECASE))
    if not matches:
        return None
    return int(Decimal((matches[-1].group(1) or matches[-1].group(2)).replace(',', '')) * 100)


def render_result(result):
    """
    Render a commerce result as the canonical chat response.

    :param result: The commerce result for the current turn.
    :return: The chat response text.
    """
    if result.get("error"):
        return result["error"]
    state = result["state"]
    if state == "SETTLED":
        receipt = result["receipt"]
        trip = result["trip"]
        return (f"Your simulated Seabreeze Inn booking is confirmed for {trip['arrival']} to {trip['departure']}. "
                f"Total: ${receipt['paid_cents']/100:,.2f}. Receipt: {receipt['reservation']}. "
                "No real money moved and no real room was reserved.")
    if state == "NO_AGREEMENT":
        return ("The arbiter found no offer within your maximum. Nothing was booked or charged. "
                "You can give me a different budget to try again.")
    if state in ("CANCELLED", "EXPIRED"):
        return f"Your simulated booking is {state.lower()}. Nothing was charged and any hold was released."
    offers = result.get("offers", [])
    if offers:
        offer = offers[0]
        return (f"The arbiter negotiated Seabreeze Inn at ${offer['total_cents']/100:,.2f} "
                f"for {offer['trip']['arrival']} to {offer['trip']['departure']}.\n\n"
                f"{offer['scope']}\n\n{offer['cancellation']}\n\n"
                "Nothing is booked or charged yet. Reply ‘Confirm booking’ to approve this exact offer, "
                "or ask me to cancel. The offer expires 15 minutes after negotiation.")
    return ("Your private mandate is recorded. The Inn has not returned a completed offer yet; "
            "ask me to retry negotiation.")


class ButterpinkCommerceBoundary(AgentMiddleware):
    """
    Agent middleware that binds a private commerce turn and replaces the final reply with the canonical result.
    """

    def __init__(self, sly_data=None, **kwargs):  # pylint: disable=unused-argument; Neuro-SAN middleware signature
        """
        Initialize the boundary.

        :param sly_data: The private sly_data shared with the commerce tools.
        :param kwargs: Additional middleware arguments, ignored.
        """
        self.sly_data = sly_data if sly_data is not None else {}
        self.turn = None

    async def awrap_model_call(self, request, handler):
        """
        Start the private turn on the first model call and render the settled result.

        :param request: The model request.
        :param handler: The next handler in the middleware chain.
        :return: The model response.
        """
        if self.turn is None:
            messages = request.messages
            human = next((message for message in reversed(messages) if isinstance(message, HumanMessage)), None)
            text = str(human.content) if human else ""
            try:
                binding = start_binding(self.sly_data)
            except PermissionError as exc:
                return ModelResponse(result=[AIMessage(content=str(exc))])
            budget = budget_from_text(text)
            if budget is not None:
                binding["requested_budget"] = budget
            approved = binding["presented_offer"] if confirms_booking(text) else None
            self.turn = PrivateTurn(secrets.token_hex(16), confirmed_offer=approved)
            self.sly_data[TURN] = self.turn
        response = await handler(request)
        if (self.turn.result and response.result and isinstance(response.result[-1], AIMessage)
                and not response.result[-1].tool_calls):
            result = self.turn.result
            binding = binding_for(self.sly_data)
            if binding and result.get("state") == "NEGOTIATING" and result.get("offers"):
                binding["presented_offer"] = result["offers"][0]["offer_id"]
            return ModelResponse(result=[AIMessage(content=render_result(result))])
        return response
