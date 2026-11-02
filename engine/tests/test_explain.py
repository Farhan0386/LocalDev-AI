import json
from threading import Event
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import pytest

from localdev_ai_engine.ollama import OllamaClient, OllamaError


class Response:
    status = 200

    def __init__(self, value, lines=None):
        self.value = json.dumps(value).encode()
        self.lines = lines

    def read(self):
        return self.value

    def __iter__(self):
        return iter(self.lines or [self.value])

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None


def test_successful_explanation_uses_non_streaming_chat():
    requests = []

    def opener(request, timeout):
        requests.append(request)
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "qwen2.5:latest"}]})
        assert request.full_url.endswith("/api/chat")
        body = json.loads(request.data)
        assert body["model"] == "qwen2.5:latest"
        assert body["stream"] is False
        assert "Explain" in body["messages"][0]["content"]
        return Response({"message": {"content": "The loop iterates over the values."}})

    explanation = OllamaClient("http://example.test", opener=opener).explain_code(
        "qwen2.5:latest", "for value in values:\n    print(value)", "What does this do?"
    )
    assert explanation == "The loop iterates over the values."
    assert len(requests) == 2


def test_empty_code_is_rejected_without_http():
    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=lambda *_: Response({})).explain_code("model", "  ")
    assert error.value.code == "REQUEST_INVALID"


def test_invalid_model_is_rejected():
    def opener(request, timeout):
        return Response({"models": []})

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=opener).explain_code("missing", "print('x')")
    assert error.value.code == "MODEL_NOT_FOUND"


@pytest.mark.parametrize(
    "response",
    [Response({"message": {}}), Response({"unexpected": True})],
)
def test_malformed_chat_response(response):
    calls = 0

    def opener(request, timeout):
        nonlocal calls
        calls += 1
        return Response({"models": [{"name": "model"}]}) if calls == 1 else response

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=opener).explain_code("model", "print('x')")
    assert error.value.code == "OLLAMA_INVALID_RESPONSE"


def test_chat_unavailable_timeout_and_http_error():
    def unavailable(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        raise URLError("refused")

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=unavailable).explain_code("model", "print('x')")
    assert error.value.code == "OLLAMA_UNAVAILABLE"

    def timeout(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        raise TimeoutError()

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=timeout).explain_code("model", "print('x')")
    assert error.value.code == "OLLAMA_UNAVAILABLE"

    def http_error(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        raise HTTPError(request.full_url, 500, "failed", {}, None)

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=http_error).explain_code("model", "print('x')")
    assert error.value.code == "OLLAMA_HTTP_ERROR"


def test_streaming_explanation_emits_ordered_tokens():
    tokens = [
        json.dumps({"message": {"content": "First "}, "done": False}).encode(),
        json.dumps({"message": {"content": "second."}, "done": False}).encode(),
        json.dumps({"message": {}, "done": True}).encode(),
    ]
    calls = 0

    def opener(request, timeout):
        nonlocal calls
        calls += 1
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        body = json.loads(request.data)
        assert body["stream"] is True
        return Response({}, lines=tokens)

    received = []
    result = OllamaClient(opener=opener).explain_code_stream("model", "print('x')", on_token=received.append)
    assert result == "First second."
    assert received == ["First ", "second."]
    assert calls == 2


@pytest.mark.parametrize(
    "lines, code",
    [
        ([b"{not-json}\n"], "OLLAMA_INVALID_RESPONSE"),
        ([json.dumps({"message": {"content": "partial"}, "done": False}).encode()], "OLLAMA_STREAM_INTERRUPTED"),
        ([json.dumps({"message": {}, "done": True}).encode()], "OLLAMA_INVALID_RESPONSE"),
    ],
)
def test_streaming_malformed_empty_and_interrupted(lines, code):
    calls = 0

    def opener(request, timeout):
        nonlocal calls
        calls += 1
        return Response({"models": [{"name": "model"}]}) if calls == 1 else Response({}, lines=lines)

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=opener).explain_code_stream("model", "print('x')")
    assert error.value.code == code


def test_streaming_http_error_and_timeout():
    def http_opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        raise HTTPError(request.full_url, 503, "unavailable", {}, None)

    with pytest.raises(OllamaError) as http_error:
        OllamaClient(opener=http_opener).explain_code_stream("model", "print('x')")
    assert http_error.value.code == "OLLAMA_HTTP_ERROR"

    def timeout_opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        raise TimeoutError("timed out")

    with pytest.raises(OllamaError) as timeout_error:
        OllamaClient(opener=timeout_opener).explain_code_stream("model", "print('x')")
    assert timeout_error.value.code == "OLLAMA_UNAVAILABLE"


def test_streaming_cancellation_stops_before_emitting_tokens():
    cancel_event = Event()
    received = []
    response = Response({}, lines=[
        json.dumps({"message": {"content": "late"}, "done": False}).encode(),
    ])

    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        return response

    def stream_opened(_response):
        cancel_event.set()

    with pytest.raises(OllamaError) as error:
        OllamaClient(opener=opener).explain_code_stream(
            "model",
            "print('x')",
            on_token=received.append,
            cancel_event=cancel_event,
            on_stream_open=stream_opened,
        )
    assert error.value.code == "REQUEST_CANCELLED"
    assert received == []


def test_streaming_first_token_timeout_closes_response():
    class BlockingResponse(Response):
        def __init__(self):
            super().__init__({})
            self.closed = Event()

        def __iter__(self):
            self.closed.wait(1)
            return iter(())

        def close(self):
            self.closed.set()

    response = BlockingResponse()

    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return Response({"models": [{"name": "model"}]})
        return response

    with pytest.raises(OllamaError) as error:
        OllamaClient(
            opener=opener,
            first_token_timeout_seconds=0.05,
            inactivity_timeout_seconds=0.05,
            max_request_duration_seconds=1,
        ).explain_code_stream("model", "print('x')")
    assert error.value.code == "INFERENCE_TIMEOUT"
    assert response.closed.is_set()
