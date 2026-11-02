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
    ):
        self.endpoint = _normalise_endpoint(endpoint)
        self.timeout_seconds = timeout_seconds
        self._opener = opener or urlopen
        self.first_token_timeout_seconds = first_token_timeout_seconds
        self.inactivity_timeout_seconds = inactivity_timeout_seconds
        self.max_request_duration_seconds = max_request_duration_seconds

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

    def explain_code(self, model: str, code: str, question: str = "") -> str:
        """Ask an installed Ollama model for a focused Python explanation."""

        if not code.strip():
            raise OllamaError(
                "REQUEST_INVALID",
                "No Python code was provided.",
                "Select Python code and try again.",
                retryable=False,
            )
        models = self.models()
        if not any(item.name == model for item in models):
            raise OllamaError(
                "MODEL_NOT_FOUND",
                "The selected Ollama model is not installed.",
                "Refresh models and choose an installed model.",
                retryable=False,
            )
        prompt = self._explanation_prompt(code, question)
        response = self._post_json(
            "/api/chat",
            {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": False,
            },
        )
        message = response.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip():
            raise OllamaError(
                "OLLAMA_INVALID_RESPONSE",
                "Ollama returned no explanation text.",
                "Retry the explanation request or check the selected model.",
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
        request = Request(
            f"{self.endpoint}/api/chat",
            data=json.dumps({
                "model": model,
                "messages": [{"role": "user", "content": self._explanation_prompt(code, question)}],
                "stream": True,
            }).encode("utf-8"),
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
        try:
            with self._opener(request, timeout=self.timeout_seconds) as response:
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
    def _explanation_prompt(code: str, question: str) -> str:
        prompt = (
            "Explain the following Python code for a learner. Cover what it does, "
            "how the important parts work, important functions, variables, and "
            "logic, and potential errors or issues only when clearly identifiable. "
            "Do not rewrite, modify, or execute the code."
        )
        if question.strip():
            prompt += f"\n\nUser question:\n{question.strip()}"
        prompt += f"\n\nPython code:\n```python\n{code}\n```"
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
