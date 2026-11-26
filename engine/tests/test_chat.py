import json
from threading import Event
from unittest.mock import patch

import pytest

from localdev_ai_engine.hardware import recommend_model
from localdev_ai_engine.ollama import OllamaClient, OllamaError
from localdev_ai_engine import __main__


class FakeStreamResponse:
    status = 200

    def __init__(self, lines):
        self.lines = [line if isinstance(line, bytes) else line.encode() for line in lines]

    def read(self):
        return b"".join(self.lines)

    def __iter__(self):
        return iter(self.lines)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None


def test_recommend_model_selects_appropriate_model():
    # High VRAM GPU
    high_gpu = {
        "gpu": {"present": True, "name": "RTX 4090", "vram_total_bytes": 16 * 1024**3},
        "memory": {"total_bytes": 32 * 1024**3},
    }
    rec = recommend_model(high_gpu)
    assert rec["model"] == "qwen2.5-coder:7b"
    assert rec["fit"] == "Comfortable"

    # Mid VRAM GPU
    mid_gpu = {
        "gpu": {"present": True, "name": "RTX 3050", "vram_total_bytes": 4 * 1024**3},
        "memory": {"total_bytes": 16 * 1024**3},
    }
    rec = recommend_model(mid_gpu)
    assert rec["model"] == "qwen2.5-coder:3b"

    # CPU-only high RAM
    high_ram = {
        "gpu": {"present": False},
        "memory": {"total_bytes": 16 * 1024**3},
    }
    rec = recommend_model(high_ram)
    assert rec["model"] == "qwen2.5-coder:7b"

    # Low resource
    low_res = {
        "gpu": {"present": False},
        "memory": {"total_bytes": 4 * 1024**3},
    }
    rec = recommend_model(low_res)
    assert rec["model"] == "qwen2.5-coder:1.5b"


def test_chat_session_stream_includes_workspace_context_and_mode():
    captured_body = {}

    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return FakeStreamResponse([json.dumps({"models": [{"name": "qwen2.5-coder:1.5b"}]})])
        if request.full_url.endswith("/api/chat"):
            nonlocal captured_body
            captured_body = json.loads(request.data)
            return FakeStreamResponse([
                json.dumps({"message": {"content": "Hello! "}, "done": False}),
                json.dumps({"message": {"content": "I can help."}, "done": True}),
            ])
        raise RuntimeError(f"Unexpected url: {request.full_url}")

    client = OllamaClient("http://127.0.0.1:11434", opener=opener)
    received = []
    workspace_context = {
        "active_file": {
            "path": "app.py",
            "content": "print('hello')",
            "language": "python",
            "line_range": "1-1",
        },
        "directory_tree": "app.py\nutils.py",
    }
    messages = [
        {"role": "user", "content": "How do I add a function?"}
    ]

    result = client.chat_session_stream(
        "qwen2.5-coder:1.5b",
        messages,
        workspace_context=workspace_context,
        mode="edit",
        on_token=received.append,
    )

    assert result == "Hello! I can help."
    assert received == ["Hello! ", "I can help."]
    assert captured_body["model"] == "qwen2.5-coder:1.5b"
    assert captured_body["stream"] is True
    # Verify system prompt has tool instructions and workspace context
    system_msg = captured_body["messages"][0]["content"]
    assert "localdev_tool" in system_msg
    assert "app.py" in system_msg
    assert "print('hello')" in system_msg


def test_pull_model_streams_progress():
    def opener(request, timeout):
        assert request.full_url.endswith("/api/pull")
        body = json.loads(request.data)
        assert body["name"] == "qwen2.5-coder:1.5b"
        return FakeStreamResponse([
            json.dumps({"status": "pulling manifest"}),
            json.dumps({"status": "downloading", "completed": 50, "total": 100}),
            json.dumps({"status": "success"}),
        ])

    client = OllamaClient("http://127.0.0.1:11434", opener=opener)
    progress_updates = []
    result = client.pull_model("qwen2.5-coder:1.5b", on_progress=progress_updates.append)
    assert "pulled successfully" in result
    assert "pulling manifest" in progress_updates
    assert any("50%" in p for p in progress_updates)


def test_main_protocol_handles_chat_session(monkeypatch, capsys):
    import io

    class FakeChatClient:
        def __init__(self, endpoint, timeout):
            pass

        def chat_session_stream(self, model, messages, workspace_context=None, mode="learn", on_token=None, cancel_event=None, on_stream_open=None):
            assert model == "qwen2.5-coder:1.5b"
            assert mode == "edit"
            if on_token:
                on_token("Here is a plan.")
            return "Here is a plan."

    monkeypatch.setattr(__main__, "OllamaClient", FakeChatClient)
    monkeypatch.setattr(
        "sys.stdin",
        io.StringIO(
            '{"protocol_version":"1","type":"request","request_id":"chat-1",'
            '"task":"chat_session","options":{"model":"qwen2.5-coder:1.5b","mode":"edit","messages":[{"role":"user","content":"help"}]}}\n'
        ),
    )
    __main__.main()
    messages = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert messages[0]["event"] == "ready"
    assert messages[1]["request_id"] == "chat-1"
    assert messages[1]["event"] == "token"
    assert messages[1]["text"] == "Here is a plan."
    assert messages[2]["request_id"] == "chat-1"
    assert messages[2]["type"] == "response"
    assert messages[2]["message"] == "Here is a plan."


def test_copy_and_delete_model():
    requests = []

    def opener(request, timeout):
        requests.append(request)
        if request.full_url.endswith("/api/copy"):
            body = json.loads(request.data)
            assert body["source"] == "source_mod"
            assert body["destination"] == "dest_mod"
            return FakeStreamResponse([b"{}"])
        elif request.full_url.endswith("/api/delete"):
            assert request.get_method() == "DELETE"
            return FakeStreamResponse([b"{}"])
        raise RuntimeError(f"Unexpected url: {request.full_url}")

    client = OllamaClient("http://127.0.0.1:11434", opener=opener)
    copy_res = client.copy_model("source_mod", "dest_mod")
    assert copy_res["source"] == "source_mod"

    del_res = client.delete_model("dest_mod")
    assert del_res["status"] == "success"


def test_inline_complete_generates_fim():
    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return FakeStreamResponse([json.dumps({"models": [{"name": "qwen2.5-coder:1.5b"}]})])
        if request.full_url.endswith("/api/generate"):
            body = json.loads(request.data)
            assert "<|fim_prefix|>" in body["prompt"]
            assert "def add(a, b):" in body["prompt"]
            assert body["options"]["num_predict"] == 32
            return FakeStreamResponse([json.dumps({"response": "    return a + b\n"})])
        raise RuntimeError(f"Unexpected url: {request.full_url}")

    client = OllamaClient("http://127.0.0.1:11434", opener=opener)
    res = client.inline_complete(
        "qwen2.5-coder:1.5b",
        prefix="def add(a, b):\n",
        suffix="\nprint(add(1, 2))",
        max_tokens=32,
    )
    assert res == "    return a + b\n"


def test_streaming_stats_collection():
    tokens = [
        json.dumps({"message": {"content": "Hello"}, "done": False}).encode(),
        json.dumps({
            "message": {"content": " world"},
            "done": True,
            "eval_count": 20,
            "eval_duration": 1_000_000_000,
            "prompt_eval_count": 10,
            "prompt_eval_duration": 150_000_000,
            "load_duration": 50_000_000,
            "total_duration": 1_200_000_000,
        }).encode(),
    ]

    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return FakeStreamResponse([json.dumps({"models": [{"name": "model"}]})])
        return FakeStreamResponse(tokens)

    client = OllamaClient("http://127.0.0.1:11434", opener=opener)
    client.explain_code_stream("model", "print(1)")
    stats = client.last_stats
    assert stats["eval_count"] == 20
    assert stats["prompt_eval_count"] == 10
    assert stats["tokens_per_second"] == 20.0
    assert stats["ttft_ms"] == 200.0


def test_chat_session_passes_gpu_toggle_and_num_ctx_and_budgets_history():
    captured = []

    def opener(request, timeout):
        if request.full_url.endswith("/api/tags"):
            return FakeStreamResponse([json.dumps({"models": [{"name": "qwen3:4b"}]})])
        if request.full_url.endswith("/api/chat"):
            captured.append((json.loads(request.data), timeout))
            return FakeStreamResponse([
                json.dumps({"message": {"content": "Done."}, "done": True, "eval_count": 5, "eval_duration": 100_000_000}),
            ])
        raise RuntimeError(f"Unexpected url: {request.full_url}")

    client = OllamaClient("http://127.0.0.1:11434", timeout_seconds=5.0, opener=opener)
    long_history = [
        {"role": "user", "content": f"Turn {i}: " + ("x" * 1800)}
        for i in range(6)
    ]
    result = client.chat_session_stream(
        "qwen3:4b",
        long_history,
        use_gpu=False,
        num_ctx=2048,
    )
    assert result == "Done."
    body, used_timeout = captured[0]
    assert used_timeout >= 120.0
    assert body["options"]["num_gpu"] == 0
    assert body["options"]["num_ctx"] == 2048
    assert client.last_stats["execution_mode"] == "CPU"
    # Budgeted history should trim oldest turns to stay well within num_ctx
    total_chars = sum(len(m["content"]) for m in body["messages"])
    assert total_chars < 6500
    assert any("earlier turn(s) omitted" in m["content"] for m in body["messages"] if m["role"] == "system")


def test_pull_model_reports_error_stream_and_incomplete_stream():
    def error_opener(request, timeout):
        assert timeout >= 600.0
        return FakeStreamResponse([
            json.dumps({"status": "pulling manifest"}),
            json.dumps({"error": "pull model manifest: file does not exist"}),
        ])

    client = OllamaClient("http://127.0.0.1:11434", timeout_seconds=5.0, opener=error_opener)
    with pytest.raises(OllamaError) as err:
        client.pull_model("missing:tag")
    assert err.value.code == "OLLAMA_PULL_FAILED"
    assert "file does not exist" in err.value.message

    def incomplete_opener(request, timeout):
        return FakeStreamResponse([json.dumps({"status": "pulling manifest"})])

    with pytest.raises(OllamaError) as err2:
        OllamaClient("http://127.0.0.1:11434", opener=incomplete_opener).pull_model("qwen3:4b")
    assert err2.value.code == "OLLAMA_STREAM_INTERRUPTED"


def test_recommend_model_includes_varied_catalog_and_alternatives():
    rec = recommend_model({
        "gpu": {"present": True, "name": "RTX 4060", "vram_total_bytes": 8 * 1024**3},
        "memory": {"total_bytes": 16 * 1024**3},
    })
    assert len(rec["alternatives"]) >= 3
    assert any(not name.startswith("qwen") for name in rec["alternatives"])
    catalog_names = {item["name"] for item in rec["catalog"]}
    assert {"qwen3:4b", "llama3.2:3b", "gemma3:4b", "deepseek-r1:7b", "phi4-mini:3.8b"}.issubset(catalog_names)
