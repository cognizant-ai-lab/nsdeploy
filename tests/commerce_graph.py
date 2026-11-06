"""Scripted model for tests only; real Neuro-SAN graph/tools and HTTP still run."""
import ast
from decimal import Decimal
import json
from pathlib import Path
import re
import tempfile
from typing import Any
from typing import Dict
from typing import List
from typing import Optional
from typing import Sequence

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolCall
from langchain_core.messages import ToolMessage
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import ChatResult
from neuro_san.client.agent_session_factory import AgentSessionFactory
from neuro_san.interfaces.agent_session import AgentSession

from nsdeploy.commerce.steward import binding_for


class ScriptedStewardModel(BaseChatModel):
    """Chat model that returns scripted commerce tool calls based on the latest prompt."""

    @property
    def _llm_type(self) -> str:
        """
        Return the model type identifier.

        :return: The model type string.
        """
        return "nsdeploy-commerce-test-model"

    def bind_tools(self, tools: Sequence[Any],  # pylint: disable=unused-argument; BaseChatModel API
                   **kwargs: Any) -> "ScriptedStewardModel":
        """
        Return this model unchanged; scripted calls need no tool binding.

        :param tools: The tools to bind.
        :param kwargs: Extra binding options.
        :return: This model.
        """
        return self

    def _generate(self, messages: List[BaseMessage],  # pylint: disable=unused-argument
                  stop: Optional[List[str]] = None, run_manager: Optional[CallbackManagerForLLMRun] = None,
                  **kwargs: Any) -> ChatResult:
        """
        Produce the next scripted reply or commerce tool call.

        :param messages: The conversation so far.
        :param stop: Unused stop sequences.
        :param run_manager: Unused callback manager.
        :param kwargs: Unused extra options.
        :return: The chat result.
        """
        human_index: int = max(i for i, message in enumerate(messages) if isinstance(message, HumanMessage))
        text: str = str(messages[human_index].content)
        tool_results: List[BaseMessage] = [message for message in messages[human_index + 1:]
                                           if isinstance(message, ToolMessage)]
        if tool_results:
            try:
                result: Dict[str, Any] = ast.literal_eval(str(tool_results[-1].content))
            except (ValueError, SyntaxError):
                result = json.loads(str(tool_results[-1].content))
            if ('confirm' in text.lower() or 'impatient' in text.lower()) and result.get('state') == 'NEGOTIATING':
                args: Dict[str, Any] = {'operation': 'approve', 'offer_id': result['offers'][0]['offer_id']}
            else:
                message: AIMessage = AIMessage(content='Model prose is not a receipt.')
                return ChatResult(generations=[ChatGeneration(message=message)])
        elif 'confirm' in text.lower() or 'status' in text.lower():
            args = {'operation': 'status'}
        elif 'cancel' in text.lower():
            args = {'operation': 'cancel'}
        else:
            arrival: Optional[re.Match[str]] = re.search(r'\d{4}-\d{2}-\d{2}', text)
            budget: Optional[re.Match[str]] = re.search(r'\$(\d+(?:\.\d{1,2})?)', text)
            if not arrival or not budget:
                message = AIMessage(content='What arrival date and maximum dollar budget should I use?')
                return ChatResult(generations=[ChatGeneration(message=message)])
            budget_cents: int = int(Decimal(budget.group(1)) * 100)
            args = {'operation': 'negotiate', 'arrival': arrival.group(), 'budget_cents': budget_cents}
        tool_call: ToolCall = {'id': 'commerce_' + str(len(tool_results)), 'name': 'butterpink_commerce',
                               'args': args, 'type': 'tool_call'}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content='', tool_calls=[tool_call]))])


def run(network_path: str,  # pylint: disable=too-many-locals; linear test driver
        prompts: List[str]) -> List[Dict[str, Any]]:
    """
    Exercise the same chat_context + SlyData round-trip that nsFlow uses.

    :param network_path: Path to the network JSON file.
    :param prompts: The user prompts to send in order.
    :return: One result summary per prompt.
    """
    network: Dict[str, Any] = json.loads(Path(network_path).read_text(encoding='utf-8'))
    network['llm_config'] = {'class': __name__ + '.ScriptedStewardModel'}
    temp: str
    with tempfile.TemporaryDirectory() as temp:
        path: Path = Path(temp) / 'butterpink_test.hocon'
        path.write_text(json.dumps(network))
        context: Optional[Dict[str, Any]]
        sly: Dict[str, Any]
        results: List[Dict[str, Any]]
        context, sly, results = None, {}, []
        prompt: str
        for prompt in prompts:
            session: AgentSession = AgentSessionFactory().create_session('direct', str(path), use_direct=True)
            final: Dict[str, Any] = {}
            try:
                request: Dict[str, Any] = {'user_message': {'text': prompt}, 'chat_context': context, 'sly_data': sly}
                response: Dict[str, Any]
                for response in session.streaming_chat(request):
                    if response.get('response', {}).get('text'):
                        final = response['response']
            finally:
                session.close()
            context = final.get('chat_context')
            sly = final.get('sly_data') or sly
            binding: Optional[Dict[str, Any]] = binding_for(sly)
            results.append({'text': final.get('text'), 'state': (binding or {}).get('last_result'),
                            'private_keys': sorted(sly), 'context_returned': bool(context)})
        return results
