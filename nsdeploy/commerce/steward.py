"""Butterpink's private nsFlow commerce tool and process-local chat authority."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import time
import urllib.error
from dataclasses import dataclass
from datetime import date
from datetime import timedelta

from neuro_san.interfaces.coded_tool import CodedTool

from nsdeploy.commerce.service import API
from nsdeploy.commerce.service import KEY_HEADER
from nsdeploy.commerce.service import STEWARD
from nsdeploy.commerce.service import credential_path
from nsdeploy.commerce.service import origin
from nsdeploy.commerce.service import post_json

HANDLE = "nsdeploy_butterpink_commerce_binding"
TURN = "nsdeploy_butterpink_commerce_turn"
_bindings = {}
_lock = threading.RLock()


@dataclass
class PrivateTurn:
    """Created by private middleware, never accepted from JSON/model arguments."""
    nonce: str
    confirmed_offer: str | None = None
    result: dict | None = None


def binding_for(sly_data):
    """
    Return the live private binding for a chat, pruning expired bindings.

    :param sly_data: The chat's private sly_data.
    :return: The binding, or None when the chat has no live binding.
    """
    with _lock:
        for handle in list(_bindings):
            if _bindings[handle]["local_until"] <= time.monotonic():
                del _bindings[handle]
        return _bindings.get(sly_data.get(HANDLE))


def start_binding(sly_data):
    """
    Return the chat's private binding, creating one on first use.

    :param sly_data: The chat's private sly_data; receives the binding handle when one is created.
    :return: The binding.
    :raises PermissionError: If the chat's earlier binding has expired or the runtime restarted.
    """
    binding = binding_for(sly_data)
    if binding:
        return binding
    if sly_data.get(HANDLE):
        raise PermissionError("Private booking context expired or the runtime restarted. Start a new private chat.")
    handle = secrets.token_urlsafe(32)
    binding = {"session": secrets.token_urlsafe(32), "last_result": None,
               "presented_offer": None, "requested_budget": None,
               "local_until": time.monotonic() + 86400, "lock": threading.RLock()}
    with _lock:
        _bindings[handle] = binding
    sly_data[HANDLE] = handle
    return binding


class ButterpinkCommerceGateway(CodedTool):
    """
    Private nsFlow coded tool that relays the steward's commerce operations to the arbiter.
    """

    # pylint: disable-next=too-many-locals,too-many-branches,too-many-statements  # one linear policy check
    async def async_invoke(self, args, sly_data):
        """
        Validate a commerce operation against the private turn and relay it to the arbiter.

        :param args: The tool arguments from the model.
        :param sly_data: The chat's private sly_data.
        :return: The arbiter result, or a DENIED/UNAVAILABLE result.
        """
        if not isinstance(args, dict) or not isinstance(sly_data, dict):
            return {"status": "DENIED", "error": "A private steward chat is required."}
        turn = sly_data.get(TURN)
        if not isinstance(turn, PrivateTurn):
            return {"status": "DENIED", "error": "Use the Butterpink private steward in nsFlow."}
        # Framework invocation metadata and optional schema defaults confer no authority.
        args = {key: value for key, value in args.items() if value is not None
                and key not in {"origin", "origin_str", "progress_reporter", "reservationist",
                                "activation_capsule"}}
        operation = args.get("operation")
        fields = {"operation", "arrival", "budget_cents"} if operation == "negotiate" else {"operation"}
        if operation == "approve":
            fields.add("offer_id")
        try:
            if operation not in ("negotiate", "status", "approve", "cancel") or set(args) != fields:
                raise ValueError("Use negotiate with arrival and budget_cents; approve with offer_id; "
                                 "or status/cancel without extra arguments.")
            binding = start_binding(sly_data)
            if operation == "approve" and (not turn.confirmed_offer
                                           or args["offer_id"] != turn.confirmed_offer
                                           or args["offer_id"] != binding["presented_offer"]):
                raise PermissionError("Present the exact offer first. The user must then reply "
                                      "'Confirm booking' in a later private chat turn.")
            if operation == "approve":
                offers = (binding["last_result"] or {}).get("offers", [])
                offer = next((item for item in offers if item["offer_id"] == args["offer_id"]), None)
                if not offer or offer["total_cents"] > (binding["requested_budget"] or 0):
                    raise PermissionError("This offer exceeds the user's latest stated maximum. "
                                          "Cancel it and negotiate a new mandate.")
            endpoint = origin(os.environ.get("NSDEPLOY_COMMERCE_ARBITER_URL", "http://127.0.0.1:8105"))
            deny_origins = os.environ.get('NSDEPLOY_STEWARD_DENY_ORIGINS', '')
            denied = {item.strip().rstrip('/') for item in deny_origins.split(',')}
            if endpoint in denied:
                raise PermissionError("The arbiter is denied by the private steward's local policy.")
            key = credential_path().read_text(encoding="utf-8").strip()
            payload = {"session": binding["session"]}
            if operation == "negotiate":
                # An exact type check rejects bool, which isinstance(..., int) would accept.
                # pylint: disable-next=unidiomatic-typecheck
                if not isinstance(args["arrival"], str) or type(args["budget_cents"]) is not int:
                    raise ValueError("Supply the requested arrival date (YYYY-MM-DD) "
                                     "and an integer budget in USD cents.")
                if not binding["requested_budget"] or args["budget_cents"] != binding["requested_budget"]:
                    raise PermissionError("Ask the user to state the maximum as a dollar amount, "
                                          "for example 'under $500'. Never invent or increase their budget.")
                arrival = date.fromisoformat(args["arrival"])
                payload.update(budget_cents=args["budget_cents"], trip={
                    "destination": "Cailville", "arrival": arrival.isoformat(),
                    "departure": (arrival + timedelta(days=1)).isoformat(),
                    "travelers": 2, "amenities": ["parking", "wifi"]})
            elif operation == "approve":
                payload["offer_id"] = args["offer_id"]

            # Avoid duplicate calls from parallel tool invocations in one private chat.
            def call():
                with binding["lock"]:
                    return post_json(endpoint + API + operation, payload, {KEY_HEADER: key})
            result = await asyncio.to_thread(call)
            binding["last_result"] = result
            if result["state"] in ("CANCELLED", "EXPIRED", "NO_AGREEMENT"):
                binding["presented_offer"] = None
        except urllib.error.HTTPError as exc:
            # Error bodies here are generated by our trusted adapter, never request echoes.
            try:
                message = json.loads(exc.read(8192)).get("error", "Arbiter refused this action.")
            except (ValueError, OSError):
                message = "Arbiter refused this action. Ask for booking status before retrying."
            finally:
                exc.close()
            result = {"status": "DENIED", "error": message}
        except (ValueError, KeyError, PermissionError) as exc:
            result = {"status": "DENIED", "error": str(exc)}
        except (urllib.error.URLError, TimeoutError, OSError):
            result = {"status": "UNAVAILABLE",
                      "error": "The commerce service or private credential is unavailable. Check booking status "
                               "before retrying; no successful booking is being claimed."}
        turn.result = result
        return result


def add_to_private_network(network):
    """
    Add the private commerce tool, middleware and instructions to a steward network.

    :param network: The steward network definition; modified in place.
    :return: The modified network.
    """
    front = network["tools"][0]
    front["allow"] = {"to_upstream": {"sly_data": [HANDLE]}}
    front["middleware"] = [{"class": "nsdeploy.commerce.middleware.ButterpinkCommerceBoundary",
                            "args": {"sly_data": True}}]
    front["tools"].append("butterpink_commerce")
    front["instructions"] += (
        "\nYou represent the Butterpink Family. For booking or negotiating a Seabreeze Inn stay, "
        "use butterpink_commerce directly from this private chat. This is a simulated one-night stay for two adults "
        "with parking, Wi-Fi, one local activity, taxes and fees. Ask for the arrival date and maximum USD budget "
        "if missing. Never silently change the date, duration, travelers or budget; "
        "explain the fixture scope for unsupported requests. "
        "Call negotiate with arrival YYYY-MM-DD and the user's budget_cents; it creates the mandate and engages "
        "the public arbiter and Inn over HTTP. Do not send the private ceiling through public_agent_mcp_gateway. "
        "Present the canonical price, dates, scope and cancellation terms. Ask the user to reply 'Confirm booking'. "
        "Only in a subsequent turn after explicit confirmation, call status to recover the current offer_id, "
        "then call approve with that exact ID. "
        "Use status for follow-ups and cancel when the user declines or wants to change the mandate. "
        "All steps stay here in nsFlow; no checkout website, pairing code, terminal or browser session is needed. "
        "Never invent offers, payment status or receipts. Only a SETTLED tool result is a booking. "
        "For a repeat of an already settled request report the existing receipt; "
        "start a new chat for a separate identical booking."
    )
    network["metadata"]["sample_queries"] = [
        "Book a night at Seabreeze Inn for two adults for no more than $500.",
        "What is the status of my Inn booking?",
    ]
    network["tools"].append({
        "name": "butterpink_commerce",
        "class": "nsdeploy.commerce.steward.ButterpinkCommerceGateway",
        "function": {
            "description": "Negotiate a one-night Seabreeze stay through the arbiter; inspect, cancel, "
                           "or approve an exact offer after a new human confirmation turn.",
            "parameters": {"type": "object", "properties": {
                "operation": {"type": "string", "enum": ["negotiate", "status", "approve", "cancel"]},
                "arrival": {"type": "string", "description": "Requested arrival in YYYY-MM-DD; negotiate only."},
                "budget_cents": {"type": "int", "description": "User's maximum total USD in cents; negotiate only."},
                "offer_id": {"type": "string", "description": "Exact canonical offer ID; approve only."},
            }, "required": ["operation"], "additionalProperties": False}}})
    network["metadata"]["commerce_delegation"] = {"steward": STEWARD, "interface": "private_nsflow_chat",
                                                  "human_confirmation": "subsequent_chat_turn"}
    return network
