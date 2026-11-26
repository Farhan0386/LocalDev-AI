"""Ollama connectivity and installed-model discovery."""

from __future__ import annotations

import json
from dataclasses import dataclass
from threading import Event, Thread
from time import monotonic
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434"
DEFAULT_TIMEOUT_SECONDS = 5.0
DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS = 120.0
DEFAULT_STREAMING_INACTIVITY_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_REQUEST_DURATION_SECONDS = 600.0


class OllamaError(Exception):
    """A safe, actionable error from the local Ollama API."""

    def __init__(self, code: str, message: str, action: str, retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.message = message
        self.action = action
        self.retryable = retryable


@dataclass(frozen=True)
class OllamaModel:
    """The model metadata needed by the extension."""

    name: str
    size: int | None
    modified_at: str | None
    digest: str | None
    details: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "size": self.size,
            "modified_at": self.modified_at,
            "digest": self.digest,
            "details": self.details,
        }


def _normalise_endpoint(endpoint: str) -> str:
    value = endpoint.strip().rstrip("/")
    if not value.startswith(("http://", "https://")):
        raise OllamaError(
            "OLLAMA_INVALID_ENDPOINT",
            "The Ollama endpoint must use http:// or https://.",
            "Update the LocalDev AI Ollama endpoint setting and retry.",
            retryable=False,
        )
    return value


class OllamaClient:
    """Small dependency-free client for Ollama readiness and model APIs."""

    def __init__(
        self,
        endpoint: str = DEFAULT_OLLAMA_ENDPOINT,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        opener: Callable[..., Any] | None = None,
        first_token_timeout_seconds: float = DEFAULT_FIRST_TOKEN_TIMEOUT_SECONDS,
        inactivity_timeout_seconds: float = DEFAULT_STREAMING_INACTIVITY_TIMEOUT_SECONDS,
        max_request_duration_seconds: float = DEFAULT_MAX_REQUEST_DURATION_SECONDS,
        use_gpu: bool = True,
        num_gpu: int | None = None,
        num_ctx: int | None = None,
    ):
        self.endpoint = _normalise_endpoint(endpoint)
        self.timeout_seconds = timeout_seconds
        self._opener = opener or urlopen
        self.first_token_timeout_seconds = first_token_timeout_seconds
        self.inactivity_timeout_seconds = inactivity_timeout_seconds
        self.max_request_duration_seconds = max_request_duration_seconds
        self.default_use_gpu = use_gpu
        self.default_num_gpu = num_gpu
        self.default_num_ctx = num_ctx
        self.last_stats: dict[str, Any] = {}

    def configure_inference_options(
        self,
        *,
        use_gpu: bool | None = None,
        num_gpu: int | None = None,
        num_ctx: int | None = None,
    ) -> None:
        """Set default GPU offload and context window options for subsequent requests."""
        if use_gpu is not None:
            self.default_use_gpu = use_gpu
        if num_gpu is not None:
            self.default_num_gpu = num_gpu
        if num_ctx is not None:
            self.default_num_ctx = num_ctx

    def _build_inference_options(
        self,
        *,
        use_gpu: bool | None = None,
        num_gpu: int | None = None,
        num_ctx: int | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        options: dict[str, Any] = dict(extra) if extra else {}
        effective_use_gpu = self.default_use_gpu if use_gpu is None else use_gpu
        effective_num_gpu = self.default_num_gpu if num_gpu is None else num_gpu
        effective_num_ctx = self.default_num_ctx if num_ctx is None else num_ctx

        if not effective_use_gpu:
            options["num_gpu"] = 0
        elif isinstance(effective_num_gpu, int) and not isinstance(effective_num_gpu, bool) and effective_num_gpu >= 0:
            options["num_gpu"] = effective_num_gpu
        else:
            options["num_gpu"] = -1

        if isinstance(effective_num_ctx, int) and not isinstance(effective_num_ctx, bool) and effective_num_ctx > 0:
            options["num_ctx"] = effective_num_ctx

        return options

    def _get_json(self, path: str) -> dict[str, Any]:
        request = Request(f"{self.endpoint}{path}", method="GET")
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError(
                        "OLLAMA_UNAVAILABLE",
                        "Ollama returned an unsuccessful response.",
                        "Check that Ollama is running and retry.",
                    )
                try:
                    payload = json.loads(response.read().decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise OllamaError(
                        "OLLAMA_INVALID_RESPONSE",
                        "Ollama returned malformed JSON.",
                        "Check the Ollama installation and retry.",
                        retryable=False,
                    ) from error
        except OllamaError:
            raise
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise OllamaError(
                "OLLAMA_UNAVAILABLE",
                "Ollama is not reachable.",
                "Start Ollama, check the endpoint setting, and retry.",
            ) from error
        if not isinstance(payload, dict):
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned an unexpected response shape.",
                "Check the Ollama version and retry.",
                retryable=False,
            )
        return payload

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            f"{self.endpoint}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError(
                        "OLLAMA_HTTP_ERROR",
                        "Ollama rejected the explanation request.",
                        "Check the selected model and Ollama server, then retry.",
                    )
                try:
                    result = json.loads(response.read().decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise OllamaError(
                        "OLLAMA_INVALID_RESPONSE",
                        "Ollama returned malformed explanation data.",
                        "Check the Ollama version and retry.",
                        retryable=False,
                    ) from error
        except OllamaError:
            raise
        except HTTPError as error:
            raise OllamaError(
                "OLLAMA_HTTP_ERROR",
                "Ollama rejected the explanation request.",
                "Check the selected model and Ollama server, then retry.",
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise OllamaError(
                "OLLAMA_UNAVAILABLE",
                "Ollama is not reachable.",
                "Start Ollama, check the endpoint setting, and retry.",
            ) from error
        if not isinstance(result, dict):
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned an unexpected explanation response.",
                "Check the Ollama version and retry.",
                retryable=False,
            )
        return result

    def version(self) -> str:
        payload = self._get_json("/api/version")
        version = payload.get("version")
        if not isinstance(version, str) or not version.strip():
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama did not provide a valid server version.",
                "Check the Ollama installation and retry.",
                retryable=False,
            )
        return version

    def models(self) -> list[OllamaModel]:
        payload = self._get_json("/api/tags")
        raw_models = payload.get("models")
        if not isinstance(raw_models, list):
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned an invalid model list.",
                "Check the Ollama version and retry.",
                retryable=False,
            )
        models: list[OllamaModel] = []
        for raw_model in raw_models:
            if not isinstance(raw_model, dict) or not isinstance(raw_model.get("name"), str):
                raise OllamaError(
                    "OLLAMA_INVALID_RESPONSE",
                    "Ollama returned invalid model metadata.",
                    "Check the Ollama version and retry.",
                    retryable=False,
                )
            size = raw_model.get("size")
            if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size < 0):
                size = None
            modified_at = raw_model.get("modified_at")
            digest = raw_model.get("digest")
            details = raw_model.get("details")
            models.append(
                OllamaModel(
                    name=raw_model["name"],
                    size=size,
                    modified_at=modified_at if isinstance(modified_at, str) else None,
                    digest=digest if isinstance(digest, str) else None,
                    details=details if isinstance(details, dict) else {},
                )
            )
        return models

    def readiness(self) -> dict[str, Any]:
        version = self.version()
        models = self.models()
        return {
            "endpoint": self.endpoint,
            "version": version,
            "models": [model.as_dict() for model in models],
        }

    def explain_code(self, model: str, code: str, question: str = "", hint_only: bool = False) -> str:
        """Ask an installed Ollama model for a focused Python explanation."""

        if not code.strip():
            raise OllamaError(
                "REQUEST_INVALID",
                "No Python code was provided.",
                "Select Python code and try again.",
                retryable=False,
            )
        return self._chat(model, self._explanation_prompt(code, question, hint_only))

    def explain_traceback(
        self,
        model: str,
        traceback: dict[str, Any],
        hint_only: bool = False,
    ) -> str:
        prompt = (
            "Explain this Python traceback for a learner. Identify the failing "
            "frame, likely cause, and next debugging step. Do not modify files.\n\n"
            f"Traceback:\n{json.dumps(traceback, indent=2)}"
        )
        return self._chat(model, self._hint_prompt(prompt, hint_only))

    def propose_patch(
        self,
        model: str,
        code: str,
        traceback: dict[str, Any],
        hint_only: bool = False,
    ) -> str:
        if not code.strip():
            raise OllamaError(
                "REQUEST_INVALID",
                "No Python code was provided.",
                "Open a Python file and retry.",
                retryable=False,
            )
        prompt = (
            "Propose the smallest safe fix for this Python source and traceback. "
            "Return only a unified diff inside one ```diff block. Do not write or "
            "apply files and do not include unrelated formatting changes.\n\n"
            f"Traceback:\n{json.dumps(traceback, indent=2)}\n\n"
            f"Python source:\n```python\n{code}\n```"
        )
        result = self._chat(model, self._hint_prompt(prompt, hint_only))
        if not result.startswith("```diff") or not result.rstrip().endswith("```"):
            raise OllamaError(
                "INVALID_PATCH",
                "The model returned an invalid patch proposal.",
                "Retry the patch proposal.",
                retryable=True,
            )
        return result.strip()

    def _chat(self, model: str, prompt: str) -> str:
        if not any(item.name == model for item in self.models()):
            raise OllamaError(
                "MODEL_NOT_FOUND",
                "The selected Ollama model is not installed.",
                "Refresh models and choose an installed model.",
                retryable=False,
            )
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
        }
        inference_options = self._build_inference_options()
        if inference_options:
            payload["options"] = inference_options
        response = self._post_json("/api/chat", payload)
        message = response.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned no explanation text.",
                "Retry the request or check the selected model.",
                retryable=False,
            )
        return content.strip()

    def explain_code_stream(
        self,
        model: str,
        code: str,
        question: str = "",
        on_token: Callable[[str], None] | None = None,
        cancel_event: Event | None = None,
        on_stream_open: Callable[[Any], None] | None = None,
        hint_only: bool = False,
    ) -> str:
        """Stream a Python explanation and return the complete text."""

        if not code.strip():
            raise OllamaError(
                "REQUEST_INVALID",
                "No Python code was provided.",
                "Select Python code and try again.",
                retryable=False,
            )
        if not any(item.name == model for item in self.models()):
            raise OllamaError(
                "MODEL_NOT_FOUND",
                "The selected Ollama model is not installed.",
                "Refresh models and choose an installed model.",
                retryable=False,
            )
        messages = [{"role": "user", "content": self._explanation_prompt(code, question, hint_only)}]
        return self._stream_chat_messages(model, messages, on_token, cancel_event, on_stream_open)

    def chat_session_stream(
        self,
        model: str,
        messages: list[dict[str, Any]],
        workspace_context: dict[str, Any] | None = None,
        mode: str = "learn",
        on_token: Callable[[str], None] | None = None,
        cancel_event: Event | None = None,
        on_stream_open: Callable[[Any], None] | None = None,
        num_ctx: int | None = None,
        use_gpu: bool | None = None,
        num_gpu: int | None = None,
    ) -> str:
        """Stream a multi-turn chat response with budgeted workspace context and GPU/ctx options."""

        if not any(item.name == model for item in self.models()):
            raise OllamaError(
                "MODEL_NOT_FOUND",
                "The selected Ollama model is not installed.",
                "Refresh models and choose an installed model.",
                retryable=False,
            )
        effective_num_ctx = self.default_num_ctx if num_ctx is None else num_ctx
        system_prompt = self._build_chat_system_prompt(mode, workspace_context)
        payload_messages = self._budget_chat_messages(system_prompt, messages, effective_num_ctx)
        return self._stream_chat_messages(
            model,
            payload_messages,
            on_token,
            cancel_event,
            on_stream_open,
            num_ctx=num_ctx,
            use_gpu=use_gpu,
            num_gpu=num_gpu,
        )

    @staticmethod
    def _budget_chat_messages(
        system_prompt: str,
        messages: list[dict[str, Any]],
        num_ctx: int | None,
    ) -> list[dict[str, str]]:
        """Bound multi-turn history and system prompt to stay safely within num_ctx."""
        char_budget = max(3200, int(num_ctx * 2.8)) if isinstance(num_ctx, int) and num_ctx > 0 else 12000
        max_system_chars = int(char_budget * 0.55)
        if len(system_prompt) > max_system_chars:
            system_prompt = system_prompt[:max_system_chars] + "\n... [workspace context trimmed to fit context window]"

        cleaned: list[dict[str, str]] = []
        for msg in messages:
            if not isinstance(msg, dict) or "role" not in msg or "content" not in msg:
                continue
            role = str(msg["role"]).strip()
            content = str(msg["content"])
            if role not in {"user", "assistant", "system"}:
                continue
            if role == "assistant" and not content.strip():
                continue
            cleaned.append({"role": role, "content": content})

        remaining = max(1200, char_budget - len(system_prompt))
        selected_reversed: list[dict[str, str]] = []
        dropped_count = 0

        for idx in range(len(cleaned) - 1, -1, -1):
            msg = cleaned[idx]
            content = msg["content"]
            is_latest = idx == len(cleaned) - 1
            if is_latest and len(content) > remaining:
                content = content[:remaining] + "\n... [prompt truncated to fit context window]"
            msg_len = len(content) + 32
            if not is_latest and msg_len > remaining:
                dropped_count = idx + 1
                break
            selected_reversed.append({"role": msg["role"], "content": content})
            remaining = max(0, remaining - msg_len)

        selected_reversed.reverse()
        result = [{"role": "system", "content": system_prompt}]
        if dropped_count > 0:
            result.append({
                "role": "system",
                "content": f"[Note: {dropped_count} earlier turn(s) omitted to fit local context window.]",
            })
        result.extend(selected_reversed)
        return result

    def pull_model(
        self,
        name: str,
        on_progress: Callable[[str], None] | None = None,
        cancel_event: Event | None = None,
        on_stream_open: Callable[[Any], None] | None = None,
    ) -> str:
        """Pull a model from Ollama, streaming download progress and validating completion."""
        name = name.strip()
        if not name:
            raise OllamaError("REQUEST_INVALID", "No model name was provided to pull.", "Provide a model name and retry.", retryable=False)
        request = Request(
            f"{self.endpoint}/api/pull",
            data=json.dumps({"name": name, "stream": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        last_status = ""
        last_pct = -1
        saw_success = False
        pull_timeout = max(self.timeout_seconds, 600.0)
        try:
            with self._opener(request, timeout=pull_timeout) as response:
                if on_stream_open:
                    on_stream_open(response)
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError(
                        "OLLAMA_HTTP_ERROR",
                        f"Ollama rejected the pull request for '{name}'.",
                        "Check model name and network connection, then retry.",
                    )
                for raw_line in response:
                    if cancel_event and cancel_event.is_set():
                        raise OllamaError("REQUEST_CANCELLED", "The model pull was cancelled.", "Pull the model again when ready.", retryable=False)
                    line = raw_line.decode("utf-8", errors="replace").strip() if isinstance(raw_line, bytes) else str(raw_line).strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(chunk, dict):
                        continue
                    if chunk.get("error"):
                        raise OllamaError(
                            "OLLAMA_PULL_FAILED",
                            f"Failed to pull '{name}': {chunk['error']}",
                            "Verify the model tag exists in the Ollama library and check your network connection.",
                        )
                    status_text = str(chunk.get("status", "")).strip()
                    total = chunk.get("total")
                    completed = chunk.get("completed")
                    digest = str(chunk.get("digest", "")).strip()
                    digest_short = digest.split(":")[-1][:8] if digest else ""
                    if isinstance(total, int) and isinstance(completed, int) and total > 0:
                        pct = min(100, max(0, int((completed / total) * 100)))
                        comp_mb = completed / (1024 * 1024)
                        tot_mb = total / (1024 * 1024)
                        prefix = f"{status_text} [{digest_short}]" if digest_short else status_text
                        msg = f"{prefix} ({pct}% — {comp_mb:.0f}/{tot_mb:.0f} MiB)"
                        if pct != last_pct or status_text != last_status:
                            last_pct = pct
                            last_status = status_text
                            if on_progress:
                                on_progress(msg)
                    else:
                        msg = status_text
                        if msg and msg != last_status:
                            last_status = msg
                            last_pct = -1
                            if on_progress:
                                on_progress(msg)
                    if status_text == "success":
                        saw_success = True
                        return f"Model '{name}' pulled successfully."
        except OllamaError:
            raise
        except HTTPError as error:
            detail = ""
            try:
                body = error.read().decode("utf-8", errors="replace")
                parsed = json.loads(body)
                if isinstance(parsed, dict) and parsed.get("error"):
                    detail = f" ({parsed['error']})"
            except Exception:
                pass
            raise OllamaError(
                "OLLAMA_PULL_FAILED",
                f"Ollama rejected pulling '{name}'{detail}.",
                "Check the model tag name and Ollama server logs, then retry.",
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("REQUEST_CANCELLED", "The model pull was cancelled.", "Pull the model again when ready.", retryable=False) from error
            raise OllamaError("OLLAMA_UNAVAILABLE", f"Ollama model pull failed: {error}", "Check network connection and Ollama service, then retry.") from error

        if not saw_success:
            raise OllamaError(
                "OLLAMA_STREAM_INTERRUPTED",
                f"Pull stream for '{name}' ended before completion.",
                "Retry pulling the model or check Ollama server connectivity.",
            )
        return f"Model '{name}' pulled successfully."

    def copy_model(self, source: str, destination: str) -> dict[str, Any]:
        """Copy or duplicate a local model in Ollama."""
        source = source.strip()
        destination = destination.strip()
        if not source or not destination:
            raise OllamaError("REQUEST_INVALID", "Source and destination model names are required.", "Provide valid model names and retry.", retryable=False)
        self._post_json("/api/copy", {"source": source, "destination": destination})
        return {"status": "success", "source": source, "destination": destination}

    def delete_model(self, name: str) -> dict[str, Any]:
        """Delete an installed model from Ollama."""
        name = name.strip()
        if not name:
            raise OllamaError("REQUEST_INVALID", "Model name is required for deletion.", "Provide a model name and retry.", retryable=False)
        request = Request(
            f"{self.endpoint}/api/delete",
            data=json.dumps({"name": name}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="DELETE",
        )
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError("OLLAMA_HTTP_ERROR", f"Failed to delete model '{name}'.", "Check the model name and retry.")
        except OllamaError:
            raise
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise OllamaError("OLLAMA_UNAVAILABLE", f"Ollama model deletion failed: {error}", "Check Ollama status and retry.") from error
        return {"status": "success", "model": name}

    def inline_complete(
        self,
        model: str,
        prefix: str,
        suffix: str,
        max_tokens: int = 64,
        temperature: float = 0.1,
        cancel_event: Event | None = None,
        use_gpu: bool | None = None,
        num_gpu: int | None = None,
    ) -> str:
        """Fast Fill-In-the-Middle (FIM) code completion for ghost-text suggestions."""
        if not any(item.name == model for item in self.models()):
            raise OllamaError(
                "MODEL_NOT_FOUND",
                "The selected Ollama model is not installed.",
                "Refresh models and choose an installed model.",
                retryable=False,
            )
        prompt = f"<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>"
        gen_options = self._build_inference_options(
            use_gpu=use_gpu,
            num_gpu=num_gpu,
            extra={
                "num_predict": max_tokens,
                "temperature": temperature,
                "stop": ["<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>", "<|file_separator|>", "\n\n"],
            },
        )
        request = Request(
            f"{self.endpoint}/api/generate",
            data=json.dumps({
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": gen_options,
                "keep_alive": "5m",
            }).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener(request, timeout=max(self.timeout_seconds, 15.0)) as response:
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError("OLLAMA_HTTP_ERROR", "Ollama rejected completion request.", "Check Ollama status and retry.")
                payload = json.loads(response.read().decode("utf-8"))
        except OllamaError:
            raise
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError("REQUEST_CANCELLED", "Inline completion was cancelled.", "Keep typing or retry.", retryable=False) from error
            raise OllamaError("OLLAMA_UNAVAILABLE", "Ollama is not reachable for inline completion.", "Start Ollama and retry.") from error

        response_text = payload.get("response", "")
        for marker in ("<|fim_prefix|>", "<|fim_suffix|>", "<|fim_middle|>", "<|endoftext|>", "<|file_separator|>"):
            response_text = response_text.replace(marker, "")
        return response_text

    def _stream_chat_messages(
        self,
        model: str,
        messages: list[dict[str, str]],
        on_token: Callable[[str], None] | None = None,
        cancel_event: Event | None = None,
        on_stream_open: Callable[[Any], None] | None = None,
        num_ctx: int | None = None,
        use_gpu: bool | None = None,
        num_gpu: int | None = None,
    ) -> str:
        inference_options = self._build_inference_options(
            use_gpu=use_gpu,
            num_gpu=num_gpu,
            num_ctx=num_ctx,
        )
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
        }
        if inference_options:
            body["options"] = inference_options
        request = Request(
            f"{self.endpoint}/api/chat",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        parts: list[str] = []
        completed = False
        timeout_reason: list[str] = []
        watchdog_stop = Event()
        first_token_seen = Event()
        stream_started_at = monotonic()
        last_token_at = [stream_started_at]
        socket_timeout = max(self.timeout_seconds, self.first_token_timeout_seconds)
        effective_num_gpu = inference_options.get("num_gpu", -1)
        effective_num_ctx = inference_options.get("num_ctx")
        try:
            with self._opener(request, timeout=socket_timeout) as response:
                if on_stream_open:
                    on_stream_open(response)
                status = getattr(response, "status", 200)
                if status < 200 or status >= 300:
                    raise OllamaError(
                        "OLLAMA_HTTP_ERROR",
                        "Ollama rejected the explanation request.",
                        "Check the selected model and Ollama server, then retry.",
                    )
                def watch_stream() -> None:
                    while not watchdog_stop.wait(0.05):
                        now = monotonic()
                        if now - stream_started_at >= self.max_request_duration_seconds:
                            timeout_reason.append("maximum request duration")
                        elif not first_token_seen.is_set() and now - stream_started_at >= self.first_token_timeout_seconds:
                            timeout_reason.append("first token")
                        elif first_token_seen.is_set() and now - last_token_at[0] >= self.inactivity_timeout_seconds:
                            timeout_reason.append("streaming inactivity")
                        if timeout_reason:
                            try:
                                response.close()
                            except (AttributeError, OSError):
                                pass
                            return

                watchdog = Thread(target=watch_stream, daemon=True)
                watchdog.start()
                for raw_line in response:
                    if cancel_event and cancel_event.is_set():
                        raise OllamaError(
                            "REQUEST_CANCELLED",
                            "The explanation request was cancelled.",
                            "Start a new explanation request when ready.",
                            retryable=False,
                        )
                    if isinstance(raw_line, bytes):
                        try:
                            line = raw_line.decode("utf-8").strip()
                        except UnicodeDecodeError as error:
                            raise OllamaError(
                                "OLLAMA_INVALID_RESPONSE",
                                "Ollama returned an invalid streaming chunk.",
                                "Retry the explanation request or check the Ollama version.",
                                retryable=False,
                            ) from error
                    else:
                        line = str(raw_line).strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError as error:
                        raise OllamaError(
                            "OLLAMA_INVALID_RESPONSE",
                            "Ollama returned malformed streaming data.",
                            "Retry the explanation request or check the Ollama version.",
                            retryable=False,
                        ) from error
                    if not isinstance(chunk, dict):
                        raise OllamaError(
                            "OLLAMA_INVALID_RESPONSE",
                            "Ollama returned an invalid streaming chunk.",
                            "Retry the explanation request or check the Ollama version.",
                            retryable=False,
                        )
                    if chunk.get("error"):
                        raise OllamaError(
                            "OLLAMA_INFERENCE_ERROR",
                            f"Ollama inference error: {chunk['error']}",
                            "Try reducing context size, switching to a smaller model, or toggling dGPU.",
                            retryable=True,
                        )
                    message = chunk.get("message")
                    content = message.get("content") if isinstance(message, dict) else None
                    if content is not None and not isinstance(content, str):
                        raise OllamaError(
                            "OLLAMA_INVALID_RESPONSE",
                            "Ollama returned invalid token content.",
                            "Retry the explanation request or check the Ollama version.",
                            retryable=False,
                        )
                    if content:
                        parts.append(content)
                        first_token_seen.set()
                        last_token_at[0] = monotonic()
                        if on_token and not (cancel_event and cancel_event.is_set()):
                            on_token(content)
                    if chunk.get("done") is True:
                        completed = True
                        eval_count = chunk.get("eval_count")
                        eval_duration = chunk.get("eval_duration")
                        prompt_eval_count = chunk.get("prompt_eval_count")
                        prompt_eval_duration = chunk.get("prompt_eval_duration")
                        load_duration = chunk.get("load_duration")
                        total_duration = chunk.get("total_duration")
                        tok_per_sec = round(eval_count / (eval_duration / 1e9), 1) if eval_count and eval_duration else 0.0
                        ttft_ms = round((prompt_eval_duration + (load_duration or 0)) / 1e6, 1) if prompt_eval_duration is not None else 0.0
                        self.last_stats = {
                            "eval_count": eval_count or 0,
                            "prompt_eval_count": prompt_eval_count or 0,
                            "total_tokens": (prompt_eval_count or 0) + (eval_count or 0),
                            "eval_duration_ms": round((eval_duration or 0) / 1e6, 1),
                            "prompt_eval_duration_ms": round((prompt_eval_duration or 0) / 1e6, 1),
                            "total_duration_ms": round((total_duration or 0) / 1e6, 1),
                            "tokens_per_second": tok_per_sec,
                            "ttft_ms": ttft_ms,
                            "num_gpu": effective_num_gpu,
                            "num_ctx": effective_num_ctx,
                            "execution_mode": "CPU" if effective_num_gpu == 0 else "GPU",
                        }
                        break
        except OllamaError:
            raise
        except HTTPError as error:
            raise OllamaError(
                "OLLAMA_HTTP_ERROR",
                "Ollama rejected the explanation request.",
                "Check the selected model and Ollama server, then retry.",
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            if cancel_event and cancel_event.is_set():
                raise OllamaError(
                    "REQUEST_CANCELLED",
                    "The explanation request was cancelled.",
                    "Start a new explanation request when ready.",
                    retryable=False,
                ) from error
            if timeout_reason:
                raise OllamaError(
                    "INFERENCE_TIMEOUT",
                    f"Ollama did not complete the explanation stream before the {timeout_reason[0]} timeout.",
                    "Retry the request or use a responsive Ollama model.",
                ) from error
            raise OllamaError(
                "OLLAMA_UNAVAILABLE",
                "The Ollama connection ended during streaming.",
                "Check that Ollama is running and retry.",
            ) from error
        finally:
            watchdog_stop.set()
        if not completed:
            if cancel_event and cancel_event.is_set():
                raise OllamaError(
                    "REQUEST_CANCELLED",
                    "The explanation request was cancelled.",
                    "Start a new explanation request when ready.",
                    retryable=False,
                )
            if timeout_reason:
                raise OllamaError(
                    "INFERENCE_TIMEOUT",
                    f"Ollama did not complete the explanation stream before the {timeout_reason[0]} timeout.",
                    "Retry the request or use a responsive Ollama model.",
                )
            raise OllamaError(
                "OLLAMA_STREAM_INTERRUPTED",
                "The Ollama explanation stream ended unexpectedly.",
                "Retry the explanation request.",
            )
        result = "".join(parts).strip()
        if cancel_event and cancel_event.is_set():
            raise OllamaError(
                "REQUEST_CANCELLED",
                "The explanation request was cancelled.",
                "Start a new explanation request when ready.",
                retryable=False,
            )
        if not result:
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned an empty explanation.",
                "Retry the explanation request or check the selected model.",
                retryable=False,
            )
        return result

    @staticmethod
    def _build_chat_system_prompt(mode: str, workspace_context: dict[str, Any] | None) -> str:
        if mode == "edit":
            system_role = (
                "You are LocalDev AI, an expert local software engineering assistant. "
                "You help the user inspect, edit, refactor, and build software in their workspace.\n"
                "CRITICAL SAFETY RULE: You cannot directly modify files on disk yourself. "
                "To propose file operations, you MUST include structured tool blocks formatted as:\n"
                "```localdev_tool\n"
                "{\n"
                '  "action": "create" | "update" | "delete" | "read",\n'
                '  "path": "relative/path/to/file",\n'
                '  "explanation": "Brief explanation of this change",\n'
                '  "content": "Full file content (for create or full update)",\n'
                '  "diff": "Unified diff @@ ... @@ (for update/patch)"\n'
                "}\n"
                "```\n"
                "The user will review your proposal and click Approve to apply it. "
                "Always accompany tool proposals with clear explanations."
            )
        else:
            system_role = (
                "You are LocalDev AI, an educational, privacy-preserving local coding mentor. "
                "Explain concepts clearly with pedagogical hints, break down logic step-by-step, "
                "and guide the user to understand their code. Do not propose unprompted file deletions or destructive actions."
            )

        if not workspace_context:
            return system_role

        context_sections = []
        active_file = workspace_context.get("active_file")
        if isinstance(active_file, dict) and active_file.get("path"):
            code = active_file.get("content", "")
            lang = active_file.get("language", "python")
            lines = active_file.get("line_range", "")
            lines_str = f" ({lines})" if lines else ""
            context_sections.append(f"--- ACTIVE FILE: {active_file['path']}{lines_str} ---\n```{lang}\n{code}\n```")

        referenced_files = workspace_context.get("referenced_files")
        if isinstance(referenced_files, list):
            for ref in referenced_files:
                if isinstance(ref, dict) and ref.get("path"):
                    context_sections.append(f"--- REFERENCED FILE: {ref['path']} ---\n```\n{ref.get('content', '')}\n```")

        tree = workspace_context.get("directory_tree")
        if isinstance(tree, str) and tree.strip():
            context_sections.append(f"--- WORKSPACE DIRECTORY STRUCTURE ---\n{tree.strip()}")

        if context_sections:
            return f"{system_role}\n\n=== WORKSPACE CONTEXT ===\n" + "\n\n".join(context_sections) + "\n=== END WORKSPACE CONTEXT ==="
        return system_role

    @staticmethod
    def _explanation_prompt(code: str, question: str, hint_only: bool = False) -> str:
        prompt = (
            "Explain the following Python code for a learner. Cover what it does, "
            "how the important parts work, important functions, variables, and "
            "logic, and potential errors or issues only when clearly identifiable. "
            "Do not rewrite, modify, or execute the code."
        )
        prompt = OllamaClient._hint_prompt(prompt, hint_only)
        if question.strip():
            prompt += f"\n\nUser question:\n{question.strip()}"
        prompt += f"\n\nPython code:\n```python\n{code}\n```"
        return prompt

    @staticmethod
    def _hint_prompt(prompt: str, hint_only: bool) -> str:
        if hint_only:
            return f"{prompt}\n\nGive hints and guiding questions first. Do not reveal the complete answer."
        return prompt


def validate_selected_model(models: list[OllamaModel], selected: str) -> OllamaModel:
    """Return a selected installed model or raise a safe actionable error."""

    for model in models:
        if model.name == selected:
            return model
    raise OllamaError(
        "MODEL_NOT_FOUND",
        "The selected Ollama model is not installed.",
        "Refresh models and choose an installed model.",
        retryable=False,
    )
