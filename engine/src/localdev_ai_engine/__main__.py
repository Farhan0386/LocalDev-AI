"""JSONL command-line entry point for the local engine."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from threading import Event, Lock, Thread
from typing import Any

from .ollama import DEFAULT_OLLAMA_ENDPOINT, OllamaClient, OllamaError
from .status import health_status

PROTOCOL_VERSION = "1"
MAX_JSONL_MESSAGE_BYTES = 64 * 1024
SUPPORTED_TASKS = {"check_setup", "discover_models", "select_model", "explain_code"}
SUPPORTED_LANGUAGE = "python"
REQUEST_FIELDS = {
    "protocol_version",
    "type",
    "request_id",
    "task",
    "language",
    "code",
    "question",
    "context",
    "options",
}


@dataclass
class ActiveInference:
    request: dict[str, object]
    cancel_event: Event = field(default_factory=Event)
    response: Any = None
    terminal_sent: bool = False
    lock: Lock = field(default_factory=Lock)
    thread: Thread | None = None


def main() -> None:
    """Run the long-lived stdin/stdout protocol loop."""

    output_lock = Lock()
    active: ActiveInference | None = None
    active_lock = Lock()
    _write({"protocol_version": PROTOCOL_VERSION, "type": "event", "event": "ready"}, output_lock)

    for line in sys.stdin:
        if len(line.encode("utf-8")) > MAX_JSONL_MESSAGE_BYTES:
            _error({}, "REQUEST_TOO_LARGE", "The JSONL message exceeds the 64 KB limit.", "Reduce the request size and retry.", False, output_lock)
            continue
        if not line.strip():
            _error({}, "PROTOCOL_ERROR", "The engine received an empty JSONL message.", "Send a typed request and retry.", False, output_lock)
            continue
        try:
            request = json.loads(line, parse_constant=_reject_json_constant)
        except (json.JSONDecodeError, ValueError):
            _write({
                "protocol_version": PROTOCOL_VERSION,
                "type": "error",
                "request_id": None,
                "code": "PROTOCOL_ERROR",
                "message": "The engine received invalid JSON.",
                "action": "Send valid JSONL and retry.",
                "retryable": False,
            }, output_lock)
            continue
        if not isinstance(request, dict):
            _error({}, "REQUEST_INVALID", "The engine expected a JSON object.", "Send a typed request and retry.", False, output_lock)
            continue
        validation_error = _validate_message(request)
        if validation_error:
            code, message, action = validation_error
            _error(request, code, message, action, False, output_lock)
            continue

        if request["type"] == "cancel":
            request_id = request.get("request_id")
            with active_lock:
                current = active
                matches = current is not None and current.request.get("request_id") == request_id
                if matches and current:
                    current.cancel_event.set()
                    response = current.response
            if matches and current:
                if response is not None:
                    try:
                        response.close()
                    except (AttributeError, OSError):
                        pass
            continue

        task = request.get("task")
        if task == "explain_code":
            with active_lock:
                if active is not None and active.thread is not None and active.thread.is_alive():
                    _error(request, "BUSY", "An explanation request is already active.", "Wait for it to finish or cancel it, then retry.", True, output_lock)
                    continue
                active = ActiveInference(request)
                worker = Thread(
                    target=_run_inference,
                    args=(active, output_lock, active_lock),
                    daemon=True,
                )
                active.thread = worker
                worker.start()
            continue

        options = request.get("options")
        options = options if isinstance(options, dict) else {}
        endpoint = options.get("ollama_endpoint", DEFAULT_OLLAMA_ENDPOINT)
        timeout = options.get("ollama_timeout_seconds", 5.0)
        if not isinstance(endpoint, str):
            _error(request, "REQUEST_INVALID", "The Ollama endpoint setting is invalid.", "Update the endpoint setting and retry.", False, output_lock)
            continue
        if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            _error(request, "REQUEST_INVALID", "The Ollama timeout setting is invalid.", "Use a positive timeout in seconds and retry.", False, output_lock)
            continue
        if task == "check_setup":
            _respond(request, task, health_status(), output_lock)
        elif task in {"discover_models", "select_model"}:
            try:
                readiness = OllamaClient(endpoint, float(timeout)).readiness()
                models = readiness["models"]
                if task == "select_model":
                    selected = options.get("model")
                    if not isinstance(selected, str) or selected not in {model["name"] for model in models}:
                        raise OllamaError("MODEL_NOT_FOUND", "The selected Ollama model is not installed.", "Refresh models and choose an installed model.", False)
                    readiness["selected_model"] = selected
                _respond(request, task, readiness, output_lock)
            except OllamaError as error:
                _error(request, error.code, error.message, error.action, error.retryable, output_lock)
        else:
            _error(request, "REQUEST_INVALID", "This engine task is not implemented yet.", "Retry after the requested Phase 2 feature is available.", False, output_lock)

    with active_lock:
        current = active
        worker = current.thread if current else None
    if worker:
        worker.join(timeout=2)
    with active_lock:
        still_active = active if active and active.thread and active.thread.is_alive() else None
        if still_active:
            still_active.cancel_event.set()
            response = still_active.response
        else:
            response = None
    if response is not None:
        try:
            response.close()
        except (AttributeError, OSError):
            pass
    if still_active and still_active.thread:
        still_active.thread.join(timeout=2)


def _run_inference(active: ActiveInference, output_lock: Lock, active_lock: Lock) -> None:
    request = active.request
    options = request.get("options")
    options = options if isinstance(options, dict) else {}
    endpoint = options.get("ollama_endpoint", DEFAULT_OLLAMA_ENDPOINT)
    timeout = options.get("ollama_timeout_seconds", 5.0)
    model = options.get("model")
    code = request.get("code")
    question = request.get("question", "")
    try:
        if not isinstance(endpoint, str) or not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0:
            raise OllamaError("REQUEST_INVALID", "The Ollama settings are invalid.", "Update the endpoint and timeout settings, then retry.", False)
        if not isinstance(model, str) or not model.strip():
            raise OllamaError("MODEL_NOT_FOUND", "No Ollama model is selected.", "Select an installed model and retry.", False)
        if not isinstance(code, str) or not code.strip():
            raise OllamaError("REQUEST_INVALID", "No Python code was provided.", "Select Python code and try again.", False)
        if not isinstance(question, str):
            raise OllamaError("REQUEST_INVALID", "The explanation question must be text.", "Remove the invalid question and retry.", False)
        sequence = 0

        def emit_token(token: str) -> None:
            nonlocal sequence
            if active.cancel_event.is_set():
                return
            sequence += 1
            _write({
                "protocol_version": PROTOCOL_VERSION,
                "type": "event",
                "request_id": request.get("request_id"),
                "event": "token",
                "sequence": sequence,
                "text": token,
            }, output_lock)

        def stream_opened(response: Any) -> None:
            with active_lock:
                active.response = response
                cancelled = active.cancel_event.is_set()
            if cancelled:
                try:
                    response.close()
                except (AttributeError, OSError):
                    pass

        explanation = OllamaClient(endpoint, float(timeout)).explain_code_stream(
            model, code, question, emit_token, active.cancel_event, stream_opened
        )
        if not active.cancel_event.is_set():
            _finish(active, lambda: _respond(request, "explain_code", explanation, output_lock), active_lock)
    except OllamaError as error:
        if active.cancel_event.is_set() or error.code == "REQUEST_CANCELLED":
            _finish(
                active,
                lambda: _error(
                    request,
                    "REQUEST_CANCELLED",
                    "The explanation request was cancelled.",
                    "Start a new explanation request when ready.",
                    False,
                    output_lock,
                ),
                active_lock,
            )
        else:
            _finish(active, lambda: _error(request, error.code, error.message, error.action, error.retryable, output_lock), active_lock)
    except Exception as error:
        if active.cancel_event.is_set():
            _finish(
                active,
                lambda: _error(
                    request,
                    "REQUEST_CANCELLED",
                    "The explanation request was cancelled.",
                    "Start a new explanation request when ready.",
                    False,
                    output_lock,
                ),
                active_lock,
            )
        else:
            _finish(active, lambda: _error(request, "INFERENCE_FAILED", "The explanation request failed unexpectedly.", "Retry the request and check the Ollama server.", True, output_lock), active_lock)
            print(f"[LocalDev AI engine] inference failure: {error}", file=sys.stderr, flush=True)
def _finish(active: ActiveInference, write_terminal: Any, active_lock: Lock) -> None:
    with active.lock:
        if active.terminal_sent:
            return
        active.terminal_sent = True
    write_terminal()


def _write(message: dict[str, object], output_lock: Lock) -> None:
    with output_lock:
        print(json.dumps(message), flush=True)


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-standard JSON constant: {value}")


def _valid_request_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= 256
        and all(ord(character) >= 0x20 for character in value)
    )


def _validate_message(request: dict[str, object]) -> tuple[str, str, str] | None:
    if request.get("protocol_version") != PROTOCOL_VERSION:
        return (
            "PROTOCOL_ERROR",
            "The engine received an unsupported protocol version.",
            "Use protocol version 1 and retry.",
        )
    if request.get("type") not in {"request", "cancel"}:
        return (
            "REQUEST_INVALID",
            "The engine received an unsupported message type.",
            "Send a request or cancel message and retry.",
        )
    if not _valid_request_id(request.get("request_id")):
        return (
            "REQUEST_INVALID",
            "The request ID must be a non-empty text value without control characters.",
            "Send a valid request ID and retry.",
        )
    if request["type"] == "cancel":
        unexpected = set(request) - {"protocol_version", "type", "request_id"}
        if unexpected:
            return (
                "REQUEST_INVALID",
                "The cancellation message contains unsupported fields.",
                "Send only protocol_version, type, and request_id.",
            )
        return None

    task = request.get("task")
    if not isinstance(task, str) or task not in SUPPORTED_TASKS:
        return (
            "REQUEST_INVALID",
            "The requested engine task is not supported.",
            "Use a supported Phase 2 task and retry.",
        )
    unexpected = set(request) - REQUEST_FIELDS
    if unexpected:
        return (
            "REQUEST_INVALID",
            "The request contains unsupported fields.",
            "Remove unsupported fields and retry.",
        )
    if "options" in request and not isinstance(request["options"], dict):
        return (
            "REQUEST_INVALID",
            "The request options must be an object.",
            "Send options as a JSON object and retry.",
        )
    if "context" in request and not isinstance(request["context"], dict):
        return (
            "REQUEST_INVALID",
            "The request context must be an object.",
            "Send context as a JSON object and retry.",
        )
    if task == "explain_code":
        if request.get("language") != SUPPORTED_LANGUAGE:
            return (
                "REQUEST_INVALID",
                "The explanation language must be Python.",
                "Set language to python and retry.",
            )
        if not isinstance(request.get("code"), str) or not request["code"].strip():
            return (
                "REQUEST_INVALID",
                "No Python code was provided.",
                "Select Python code and try again.",
            )
        if "question" in request and not isinstance(request["question"], str):
            return (
                "REQUEST_INVALID",
                "The explanation question must be text.",
                "Remove the invalid question and retry.",
            )
    return None


def _respond(request: dict[str, object], task: str, message: object, output_lock: Lock) -> None:
    _write({
        "protocol_version": PROTOCOL_VERSION, "type": "response",
        "request_id": request.get("request_id"), "status": "ok",
        "task": task, "message": message, "patch": None, "warnings": [],
    }, output_lock)


def _error(
    request: dict[str, object],
    code: str,
    message: str,
    action: str,
    retryable: bool,
    output_lock: Lock,
) -> None:
    _write({
        "protocol_version": PROTOCOL_VERSION, "type": "error",
        "request_id": request.get("request_id") if _valid_request_id(request.get("request_id")) else None, "code": code,
        "message": message, "action": action, "retryable": retryable,
    }, output_lock)


if __name__ == "__main__":
    main()
