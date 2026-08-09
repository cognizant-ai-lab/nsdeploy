import json
import unittest
from unittest.mock import patch

from nsdeploy.theme import DEFAULT_THEME_MODEL, _chat


class _Response:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps({"choices": [{"message": {"content": "theme"}}]}).encode()


class ThemeChatTests(unittest.TestCase):
    def test_default_theme_model_is_gpt_5_6(self):
        self.assertEqual(DEFAULT_THEME_MODEL, "gpt-5.6")

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_gpt_5_payload_omits_temperature(self, urlopen):
        self.assertEqual(_chat("https://api.openai.com/v1", "key", "gpt-5.6", "system", "user"), "theme")

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data)
        self.assertNotIn("temperature", payload)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 180)

    @patch("nsdeploy.theme.urllib.request.urlopen", return_value=_Response())
    def test_other_models_keep_low_temperature(self, urlopen):
        _chat("http://127.0.0.1:11434/v1", "key", "qwen2.5:7b", "system", "user")

        request = urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data)["temperature"], 0.2)


if __name__ == "__main__":
    unittest.main()
