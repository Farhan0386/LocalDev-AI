import json
from unittest.mock import patch
from urllib.error import URLError

import pytest

from localdev_ai_engine.ollama import OllamaClient, OllamaError, OllamaModel, validate_selected_model


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None


def opener_for(*responses):
    queue = list(responses)

    def opener(request, timeout):
        assert request.full_url == "http://example.test" + ("/api/version" if len(queue) == 2 else "/api/tags")
        assert timeout == 2.5
        response = queue.pop(0)
        if isinstance(response, Exception):
            raise response
        return FakeResponse(response)

    return opener


def test_reachable_version_and_models():
    with patch("localdev_ai_engine.ollama.urlopen", opener_for({"version": "0.5.0"}, {"models": [
        {"name": "qwen2.5:latest", "size": 123, "digest": "sha", "details": {"family": "qwen2"}},
    ]})):
        client = OllamaClient("http://example.test/", timeout_seconds=2.5)
        result = client.readiness()
    assert result["version"] == "0.5.0"
    assert result["models"][0]["name"] == "qwen2.5:latest"
    assert result["models"][0]["size"] == 123


def test_empty_models_are_valid():
    with patch("localdev_ai_engine.ollama.urlopen", return_value=FakeResponse({"models": []})):
        assert OllamaClient().models() == []


@pytest.mark.parametrize("payload", [{"models": {}}, {"models": [{"size": 1}]}])
def test_malformed_model_response(payload):
    with patch("localdev_ai_engine.ollama.urlopen", return_value=FakeResponse(payload)):
        with pytest.raises(OllamaError, match="invalid"):
            OllamaClient().models()


def test_unavailable_and_timeout_are_actionable():
    with patch("localdev_ai_engine.ollama.urlopen", side_effect=URLError("refused")):
        with pytest.raises(OllamaError) as error:
            OllamaClient().version()
    assert error.value.code == "OLLAMA_UNAVAILABLE"
    assert "Start Ollama" in error.value.action

    with patch("localdev_ai_engine.ollama.urlopen", side_effect=TimeoutError()):
        with pytest.raises(OllamaError) as timeout:
            OllamaClient().version()
    assert timeout.value.code == "OLLAMA_UNAVAILABLE"


def test_invalid_version_response_and_endpoint():
    with patch("localdev_ai_engine.ollama.urlopen", return_value=FakeResponse({"version": 4})):
        with pytest.raises(OllamaError) as error:
            OllamaClient().version()
    assert error.value.code == "OLLAMA_INVALID_RESPONSE"
    with pytest.raises(OllamaError):
        OllamaClient("localhost:11434")


def test_selected_model_must_still_be_installed():
    models = [OllamaModel("installed", 1, None, None, {})]
    assert validate_selected_model(models, "installed").name == "installed"
    with pytest.raises(OllamaError, match="not installed"):
        validate_selected_model(models, "removed")
