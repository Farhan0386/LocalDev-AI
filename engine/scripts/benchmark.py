"""Run a small local JSONL-engine performance and privacy baseline."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import queue
import subprocess
import sys
import threading
import time
import tracemalloc
from pathlib import Path
from urllib.parse import urlparse
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
READ_TIMEOUT_SECONDS = 30.0


def _process_memory_bytes(pid: int) -> int | None:
    """Return child high-water RSS where the current OS exposes it."""

    if platform.system() == "Windows":
        try:
            process = ctypes.windll.kernel32.OpenProcess(0x0410, False, pid)
            if not process:
                return None

            class Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", ctypes.c_ulong),
                    ("page_fault_count", ctypes.c_ulong),
                    ("peak_working_set", ctypes.c_size_t),
                    ("working_set", ctypes.c_size_t),
                    ("quota_peak_paged_pool", ctypes.c_size_t),
                    ("quota_paged_pool", ctypes.c_size_t),
                    ("quota_peak_non_paged_pool", ctypes.c_size_t),
                    ("quota_non_paged_pool", ctypes.c_size_t),
                    ("pagefile_usage", ctypes.c_size_t),
                    ("peak_pagefile_usage", ctypes.c_size_t),
                ]

            counters = Counters()
            counters.cb = ctypes.sizeof(counters)
            get_info = ctypes.windll.psapi.GetProcessMemoryInfo
            success = get_info(process, ctypes.byref(counters), counters.cb)
            ctypes.windll.kernel32.CloseHandle(process)
            return counters.peak_working_set if success else None
        except (AttributeError, OSError):
            return None

    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as status:
            for line in status:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        pass

    try:
        result = subprocess.run(
            ["ps", "-o", "rss=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=1,
            check=False,
        )
        return int(result.stdout.strip()) * 1024 if result.stdout.strip() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _reader(stream: Any, messages: queue.Queue[dict[str, Any]]) -> None:
    for line in stream:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(message, dict):
            messages.put(message)


def _local_endpoint(endpoint: str) -> bool:
    host = urlparse(endpoint).hostname
    return host in {"127.0.0.1", "::1", "localhost"}


def _cases(model: str) -> list[tuple[str, dict[str, Any]]]:
    return [
        (
            "syntax error",
            {
                "task": "explain_traceback",
                "options": {
                    "model": model,
                    "traceback": {
                        "exception_type": "SyntaxError",
                        "exception_message": "invalid syntax",
                        "frames": [{"file": "example.py", "line": 1, "function": "<module>"}],
                    },
                },
            },
        ),
        (
            "index error",
            {
                "task": "explain_traceback",
                "options": {
                    "model": model,
                    "traceback": {
                        "exception_type": "IndexError",
                        "exception_message": "list index out of range",
                        "frames": [{"file": "example.py", "line": 2, "function": "first"}],
                    },
                },
            },
        ),
        (
            "code explanation",
            {
                "task": "explain_code",
                "language": "python",
                "code": "numbers = [1, 2, 3]\nprint(sum(numbers))",
                "question": "Explain this code briefly.",
                "options": {"model": model},
            },
        ),
        (
            "patch proposal",
            {
                "task": "propose_patch",
                "options": {
                    "model": model,
                    "code": "items = []\nprint(items[0])\n",
                    "traceback": {
                        "exception_type": "IndexError",
                        "exception_message": "list index out of range",
                        "frames": [{"file": "example.py", "line": 2, "function": "<module>"}],
                    },
                },
            },
        ),
    ]


def _run_case(
    process: subprocess.Popen[str],
    messages: queue.Queue[dict[str, Any]],
    name: str,
    request: dict[str, Any],
    request_number: int,
) -> dict[str, Any]:
    request_id = f"benchmark-{request_number}"
    request = {
        "protocol_version": "1",
        "type": "request",
        "request_id": request_id,
        **request,
    }
    started = time.perf_counter()
    first_token: float | None = None
    peak_memory: int | None = None
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    status = "ok"
    while True:
        memory = _process_memory_bytes(process.pid)
        if memory is not None:
            peak_memory = max(peak_memory or 0, memory)
        try:
            message = messages.get(timeout=READ_TIMEOUT_SECONDS)
        except queue.Empty:
            status = "timeout"
            process.stdin.write(json.dumps({
                "protocol_version": "1",
                "type": "cancel",
                "request_id": request_id,
            }) + "\n")
            process.stdin.flush()
            break
        if message.get("request_id") != request_id:
            continue
        if message.get("type") == "event" and message.get("event") == "token" and first_token is None:
            first_token = time.perf_counter()
        if message.get("type") in {"response", "error"}:
            if message.get("type") == "error":
                status = str(message.get("code", "error"))
            break
    total = time.perf_counter() - started
    return {
        "case": name,
        "ttft": None if first_token is None else first_token - started,
        "total": total,
        "memory": peak_memory,
        "privacy": "PASS",
        "status": status,
    }


def _format_seconds(value: float | None) -> str:
    return "-" if value is None else f"{value:.2f}s"


def _format_memory(value: int | None) -> str:
    return "-" if value is None else f"{value / (1024 ** 2):.1f} MiB"


def run(endpoint: str, model: str) -> int:
    tracemalloc.start()
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(ROOT / "engine" / "src") + os.pathsep + environment.get("PYTHONPATH", "")
    process = subprocess.Popen(
        [sys.executable, "-m", "localdev_ai_engine"],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdin is not None and process.stdout is not None
    messages: queue.Queue[dict[str, Any]] = queue.Queue()
    threading.Thread(target=_reader, args=(process.stdout, messages), daemon=True).start()
    try:
        ready = messages.get(timeout=READ_TIMEOUT_SECONDS)
        if ready.get("event") != "ready":
            raise RuntimeError("Engine did not emit its ready handshake.")
        results = [
            _run_case(process, messages, name, {**request, "options": {
                **request.get("options", {}),
                "ollama_endpoint": endpoint,
                "ollama_timeout_seconds": READ_TIMEOUT_SECONDS,
            }}, index)
            for index, (name, request) in enumerate(_cases(model), start=1)
        ]
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    _, trace_peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    privacy = "PASS" if _local_endpoint(endpoint) else "FAIL"
    print(f"Engine: local JSONL | model: {model} | endpoint: {endpoint}")
    print(f"Privacy/no-cloud verification: {privacy} (endpoint host must be localhost)")
    print("")
    print(f"{'Case':<20} {'TTFT':>8} {'Total':>8} {'Peak engine memory':>20} {'Privacy':>9} {'Status':>18}")
    print("-" * 90)
    for result in results:
        result["privacy"] = privacy
        print(
            f"{result['case']:<20} {_format_seconds(result['ttft']):>8} "
            f"{_format_seconds(result['total']):>8} {_format_memory(result['memory']):>20} "
            f"{privacy:>9} "
            f"{result['status']:>18}"
        )
    print(f"\nBenchmark process tracemalloc peak: {_format_memory(trace_peak)}")
    return 0 if privacy == "PASS" and all(result["status"] == "ok" for result in results) else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=os.environ.get("LOCALDEV_AI_MODEL", "qwen3:4b"))
    parser.add_argument("--ollama-endpoint", default="http://127.0.0.1:11434")
    arguments = parser.parse_args()
    return run(arguments.ollama_endpoint, arguments.model)


if __name__ == "__main__":
    raise SystemExit(main())
