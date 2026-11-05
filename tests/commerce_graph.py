"""Scripted model for tests only; real Neuro-SAN graph/tools and HTTP still run."""
import ast
import json
import re
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult


class ScriptedStewardModel(BaseChatModel):
    @property
    def _llm_type(self):
        return "nsdeploy-commerce-test-model"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        human_index = max(i for i, message in enumerate(messages) if isinstance(message, HumanMessage))
        text = str(messages[human_index].content)
        tool_results = [message for message in messages[human_index + 1:] if isinstance(message, ToolMessage)]
        if tool_results:
            try:
                result = ast.literal_eval(str(tool_results[-1].content))
            except (ValueError, SyntaxError):
                result = json.loads(str(tool_results[-1].content))
            if (('confirm' in text.lower() or 'impatient' in text.lower())
                    and result.get('state') == 'NEGOTIATING'):
                args = {'operation': 'approve', 'offer_id': result['offers'][0]['offer_id']}
            else:
                return ChatResult(generations=[
                    ChatGeneration(message=AIMessage(content='Model prose is not a receipt.'))])
        elif 'confirm' in text.lower() or 'status' in text.lower():
            args = {'operation': 'status'}
        elif 'cancel' in text.lower():
            args = {'operation': 'cancel'}
        else:
            arrival = re.search(r'\d{4}-\d{2}-\d{2}', text)
            budget = re.search(r'\$(\d+(?:\.\d{1,2})?)', text)
            if not arrival or not budget:
                return ChatResult(generations=[ChatGeneration(message=AIMessage(
                    content='What arrival date and maximum dollar budget should I use?'))])
            from decimal import Decimal
            args = {'operation': 'negotiate', 'arrival': arrival.group(),
                    'budget_cents': int(Decimal(budget.group(1)) * 100)}
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content='', tool_calls=[{
            'id': 'commerce_' + str(len(tool_results)), 'name': 'butterpink_commerce', 'args': args,
            'type': 'tool_call'}]))])


def run(network_path, prompts):
    """Exercise the same chat_context + SlyData round-trip that nsFlow uses."""
    import tempfile
    from pathlib import Path
    from nsdeploy.commerce.steward import binding_for
    network = json.loads(Path(network_path).read_text())
    network['llm_config'] = {'class': __name__ + '.ScriptedStewardModel'}
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / 'butterpink_test.hocon'
        path.write_text(json.dumps(network))
        from neuro_san.client.agent_session_factory import AgentSessionFactory
        context, sly, results = None, {}, []
        for prompt in prompts:
            session = AgentSessionFactory().create_session('direct', str(path), use_direct=True)
            final = {}
            try:
                for response in session.streaming_chat({'user_message': {'text': prompt},
                                                        'chat_context': context, 'sly_data': sly}):
                    if response.get('response', {}).get('text'):
                        final = response['response']
            finally:
                session.close()
            context = final.get('chat_context')
            sly = final.get('sly_data') or sly
            binding = binding_for(sly)
            results.append({'text': final.get('text'), 'state': (binding or {}).get('last_result'),
                            'private_keys': sorted(sly), 'context_returned': bool(context)})
        return results
