"""Dependency-free local hardware diagnostics and model-fit guidance."""

from __future__ import annotations

import ctypes
import os
import platform
import shutil
import subprocess
from typing import Any


_BYTES_PER_GIB = 1024 ** 3
_MODEL_OVERHEAD = 1.2
_COMFORTABLE_HEADROOM = 1.5


def _memory_from_proc() -> tuple[int | None, int | None]:
    try:
        values: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as file:
            for line in file:
                key, _, value = line.partition(":")
                if key in {"MemTotal", "MemAvailable"}:
                    values[key] = int(value.strip().split()[0]) * 1024
        return values.get("MemTotal"), values.get("MemAvailable")
    except (OSError, ValueError, IndexError):
        return None, None


def _memory_from_windows() -> tuple[int | None, int | None]:
    class MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("length", ctypes.c_ulong),
            ("memory_load", ctypes.c_ulong),
            ("total", ctypes.c_ulonglong),
            ("available", ctypes.c_ulonglong),
            ("total_page_file", ctypes.c_ulonglong),
            ("available_page_file", ctypes.c_ulonglong),
            ("total_virtual", ctypes.c_ulonglong),
            ("available_virtual", ctypes.c_ulonglong),
            ("available_extended", ctypes.c_ulonglong),
        ]

    try:
        status = MemoryStatus()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return status.total, status.available
    except (AttributeError, OSError):
        pass
    return None, None


def _memory_from_sysconf() -> tuple[int | None, int | None]:
    try:
        total = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        available = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        return total, available
    except (AttributeError, OSError, ValueError):
        return None, None


def _probe_nvidia() -> dict[str, Any] | None:
    executable = shutil.which("nvidia-smi")
    if not executable:
        return None
    try:
        result = subprocess.run(
            [executable, "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return None
        first = result.stdout.splitlines()[0].split(",")
        if len(first) != 3:
            return None
        total_mib, free_mib = int(first[1].strip()), int(first[2].strip())
        return {
            "present": True,
            "name": first[0].strip() or None,
            "vram_total_bytes": total_mib * 1024 ** 2,
            "vram_free_bytes": free_mib * 1024 ** 2,
            "source": "nvidia-smi",
        }
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def detect_hardware() -> dict[str, Any]:
    """Return safe, serializable CPU, memory, and GPU information."""

    total, available = _memory_from_proc()
    if total is None:
        total, available = _memory_from_windows()
    if total is None:
        total, available = _memory_from_sysconf()
    gpu = _probe_nvidia() or {
        "present": False,
        "name": None,
        "vram_total_bytes": None,
        "vram_free_bytes": None,
        "source": None,
    }
    return {
        "cpu": {
            "cores": os.cpu_count() or 1,
            "architecture": platform.machine() or "unknown",
            "processor": platform.processor() or None,
        },
        "memory": {
            "total_bytes": total,
            "available_bytes": available,
        },
        "gpu": gpu,
    }


def _format_gib(value: int | float | None) -> str:
    return f"{value / _BYTES_PER_GIB:.1f} GiB" if isinstance(value, (int, float)) else "unknown"


def estimate_model_fit(hardware: dict[str, Any], models: list[dict[str, Any]]) -> dict[str, Any]:
    """Estimate whether installed Ollama models fit in local resources."""

    memory = hardware.get("memory", {})
    gpu = hardware.get("gpu", {})
    ram_available = memory.get("available_bytes")
    vram_available = gpu.get("vram_free_bytes") if gpu.get("present") else None
    results: list[dict[str, Any]] = []
    for model in models:
        size = model.get("size") if isinstance(model, dict) else None
        required = size * _MODEL_OVERHEAD if isinstance(size, int) and not isinstance(size, bool) and size >= 0 else None
        if required is None:
            label = "Unknown"
            reason = "Ollama did not report a model size."
            action = "Check the model metadata before selecting it."
        else:
            best_available = max(value for value in (ram_available, vram_available) if isinstance(value, int)) if any(
                isinstance(value, int) for value in (ram_available, vram_available)
            ) else None
            if best_available is None or best_available < required:
                label = "Too Large"
                reason = f"Estimated requirement is {_format_gib(required)}; available memory is {_format_gib(best_available)}."
                action = "Install a smaller or more heavily quantized model, or close other applications."
            elif best_available < required * _COMFORTABLE_HEADROOM:
                label = "Tight"
                reason = f"Estimated requirement is {_format_gib(required)} with limited headroom."
                action = "Close memory-heavy applications and expect slower generation or swapping."
            else:
                label = "Comfortable"
                reason = f"Estimated requirement is {_format_gib(required)}; available memory is {_format_gib(best_available)}."
                action = "The model should be a reasonable local choice."
        results.append({
            "name": model.get("name", "unknown") if isinstance(model, dict) else "unknown",
            "size_bytes": size,
            "estimated_required_bytes": required,
            "fit": label,
            "reason": reason,
            "guidance": action,
        })
    guidance = [
        "Model sizes are estimates; Ollama also needs runtime overhead and memory for the operating system.",
        "Prefer a Comfortable model for reliable local inference.",
    ]
    if not gpu.get("present"):
        guidance.append("No NVIDIA GPU was detected; Ollama can still use CPU/RAM, but generation may be slower.")
    return {"models": results, "guidance": guidance}


def recommend_model(hardware: dict[str, Any]) -> dict[str, Any]:
    """Recommend the optimal coding model given detected RAM/GPU."""
    gpu = hardware.get("gpu", {})
    memory = hardware.get("memory", {})
    ram_bytes = memory.get("total_bytes") or memory.get("available_bytes") or 0
    vram_bytes = gpu.get("vram_total_bytes") or gpu.get("vram_free_bytes") or 0
    has_gpu = bool(gpu.get("present"))

    ram_gib = ram_bytes / _BYTES_PER_GIB if isinstance(ram_bytes, (int, float)) and ram_bytes > 0 else 0.0
    vram_gib = vram_bytes / _BYTES_PER_GIB if isinstance(vram_bytes, (int, float)) and vram_bytes > 0 else 0.0

    if has_gpu and vram_gib >= 7.5:
        model = "qwen2.5-coder:7b"
        reason = f"Your system has {vram_gib:.1f} GiB VRAM on {gpu.get('name', 'GPU')}, ideal for running 7B models."
        fit = "Comfortable"
    elif has_gpu and vram_gib >= 3.5:
        model = "qwen2.5-coder:3b"
        reason = f"Your system has {vram_gib:.1f} GiB VRAM on {gpu.get('name', 'GPU')}, fitting 3B models comfortably."
        fit = "Comfortable"
    elif ram_gib >= 15.0:
        model = "qwen2.5-coder:7b"
        reason = f"Your system has {ram_gib:.1f} GiB RAM, sufficient to run 7B models on CPU/RAM."
        fit = "Comfortable"
    elif ram_gib >= 7.5:
        model = "qwen2.5-coder:3b"
        reason = f"Your system has {ram_gib:.1f} GiB RAM, ideal for 3B models."
        fit = "Comfortable"
    else:
        model = "qwen2.5-coder:1.5b"
        reason = f"Lightweight model suited for systems with limited memory ({ram_gib:.1f} GiB detected)."
        fit = "Comfortable"

    return {
        "model": model,
        "reason": reason,
        "fit": fit,
    }
