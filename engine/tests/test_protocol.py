import io
import json
import threading

from localdev_ai_engine import __main__


class FakeClient:
    def __init__(self, endpoint, timeout):
        pass

    def explain_code_stream(self, model, code, question, on_token, cancel_event=None, on_stream_open=None):
        assert model == "model"
        assert code == "print('hello')"
        assert question == "What does this do?"
        on_token("It prints")
        on_token(" a greeting.")
        return "It prints a greeting."


def test_explain_response_preserves_request_id(monkeypatch, capsys):
    monkeypatch.setattr(__main__, "OllamaClient", FakeClient)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            '{"protocol_version":"1","type":"request","request_id":"abc-123",'
            '"task":"explain_code","language":"python","code":"print(\'hello\')","question":"What does this do?",'
            '"options":{"model":"model"}}\n'
        ),
    )
    __main__.main()
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["event"] == "ready"
    assert messages[1]["request_id"] == "abc-123"
    assert messages[1]["sequence"] == 1
    assert messages[1]["text"] == "It prints"
    assert messages[2]["sequence"] == 2
    assert messages[3]["request_id"] == "abc-123"
    assert messages[3]["message"] == "It prints a greeting."


def test_cancellation_returns_one_terminal_error_and_allows_retry(monkeypatch, capsys):
    started = threading.Event()
    finished = threading.Event()

    class BlockingClient:
        def __init__(self, endpoint, timeout):
            pass

        def explain_code_stream(self, model, code, question, on_token, cancel_event=None, on_stream_open=None):
            started.set()
            while not cancel_event.is_set():
                cancel_event.wait(0.01)
            try:
                raise __main__.OllamaError(
                    "REQUEST_CANCELLED",
                    "The explanation request was cancelled.",
                    "Start a new explanation request when ready.",
                    False,
                )
            finally:
                finished.set()

    class Input:
        def __iter__(self):
            yield '{"protocol_version":"1","type":"request","request_id":"first","task":"explain_code","language":"python","code":"print(1)","options":{"model":"model"}}\n'
            assert started.wait(1)
            yield '{"protocol_version":"1","type":"request","request_id":"busy","task":"explain_code","language":"python","code":"print(2)","options":{"model":"model"}}\n'
            yield '{"protocol_version":"1","type":"cancel","request_id":"first"}\n'
            yield '{"protocol_version":"1","type":"cancel","request_id":"first"}\n'
            assert finished.wait(1)
            yield '{"protocol_version":"1","type":"request","request_id":"second","task":"check_setup"}\n'

    monkeypatch.setattr(__main__, "OllamaClient", BlockingClient)
    monkeypatch.setattr("sys.stdin", Input())
    __main__.main()
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    cancelled = [message for message in messages if message.get("request_id") == "first"]
    assert len(cancelled) == 1
    assert cancelled[0]["code"] == "REQUEST_CANCELLED"
    busy = [message for message in messages if message.get("request_id") == "busy"]
    assert len(busy) == 1
    assert busy[0]["code"] == "BUSY"
    assert any(message.get("request_id") == "second" for message in messages)


def _run_protocol(monkeypatch, capsys, lines):
    monkeypatch.setattr("sys.stdin", io.StringIO("".join(lines)))
    __main__.main()
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_protocol_rejects_empty_invalid_json_and_unknown_messages(monkeypatch, capsys):
    messages = _run_protocol(monkeypatch, capsys, [
        "\n",
        "{not-json}\n",
        '{"protocol_version":"1","type":"event","request_id":"x"}\n',
        '{"protocol_version":"1","type":"request","request_id":"x","task":"future_task"}\n',
    ])
    errors = messages[1:]
    assert [error["code"] for error in errors] == [
        "PROTOCOL_ERROR",
        "PROTOCOL_ERROR",
        "REQUEST_INVALID",
        "REQUEST_INVALID",
    ]


def test_protocol_rejects_missing_and_wrong_request_fields(monkeypatch, capsys):
    messages = _run_protocol(monkeypatch, capsys, [
        '{"type":"request","request_id":"x","task":"check_setup"}\n',
        '{"protocol_version":"1","type":"request","request_id":7,"task":"check_setup"}\n',
        '{"protocol_version":"1","type":"request","request_id":"x","task":"explain_code","language":"javascript","code":"print(1)"}\n',
        '{"protocol_version":"1","type":"request","request_id":"x","task":"explain_code","language":"python","code":7}\n',
        '{"protocol_version":"1","type":"request","request_id":"x","task":"check_setup","options":[]}\n',
    ])
    errors = messages[1:]
    assert len(errors) == 5
    assert all(error["code"] == "REQUEST_INVALID" or error["code"] == "PROTOCOL_ERROR" for error in errors)
    assert errors[1]["request_id"] is None


def test_protocol_rejects_invalid_cancellation_messages(monkeypatch, capsys):
    messages = _run_protocol(monkeypatch, capsys, [
        '{"protocol_version":"1","type":"cancel"}\n',
        '{"protocol_version":"1","type":"cancel","request_id":7}\n',
        '{"protocol_version":"1","type":"cancel","request_id":"x","extra":true}\n',
    ])
    errors = messages[1:]
    assert len(errors) == 3
    assert all(error["code"] == "REQUEST_INVALID" for error in errors)


def test_protocol_rejects_oversized_and_nonstandard_json(monkeypatch, capsys):
    oversized = '{"protocol_version":"1","type":"request","request_id":"x","task":"check_setup","padding":"' + ("a" * (64 * 1024)) + '"}\n'
    messages = _run_protocol(monkeypatch, capsys, [
        oversized,
        '{"protocol_version":"1","type":"request","request_id":"x","task":"check_setup","value":NaN}\n',
    ])
    assert messages[1]["code"] == "REQUEST_TOO_LARGE"
    assert messages[2]["code"] == "PROTOCOL_ERROR"


def test_protocol_handles_multiple_sequential_valid_requests(monkeypatch, capsys):
    messages = _run_protocol(monkeypatch, capsys, [
        '{"protocol_version":"1","type":"request","request_id":"one","task":"check_setup"}\n',
        '{"protocol_version":"1","type":"request","request_id":"two","task":"check_setup"}\n',
    ])
    assert [message["request_id"] for message in messages[1:]] == ["one", "two"]
