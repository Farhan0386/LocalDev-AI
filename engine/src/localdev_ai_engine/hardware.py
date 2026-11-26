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


MODEL_CATALOG: list[dict[str, Any]] = [
    # Ultra-Light (<4 GiB RAM/VRAM)
    {
        "name": "qwen2.5-coder:0.5b",
        "label": "Qwen 2.5 Coder 0.5B",
        "category": "coding",
        "size_label": "~0.4 GB",
        "tier": "ultra_light",
        "description": "Ultra-fast minimal RAM coding assistant for older laptops.",
    },
    {
        "name": "qwen2.5-coder:1.5b",
        "label": "Qwen 2.5 Coder 1.5B",
        "category": "coding",
        "size_label": "~1.0 GB",
        "tier": "ultra_light",
        "description": "Best compact coding model for 4 GB RAM or low-VRAM GPUs.",
    },
    {
        "name": "qwen3:1.7b",
        "label": "Qwen 3 1.7B",
        "category": "general",
        "size_label": "~1.4 GB",
        "tier": "ultra_light",
        "description": "Modern compact general & coding model with strong reasoning.",
    },
    {
        "name": "llama3.2:1b",
        "label": "Llama 3.2 1B",
        "category": "general",
        "size_label": "~1.3 GB",
        "tier": "ultra_light",
        "description": "Lightweight Meta Llama model for quick Q&A and explanations.",
    },
    {
        "name": "gemma3:1b",
        "label": "Gemma 3 1B",
        "category": "general",
        "size_label": "~0.8 GB",
        "tier": "ultra_light",
        "description": "Google Gemma 3 compact model with low memory footprint.",
    },
    {
        "name": "deepseek-r1:1.5b",
        "label": "DeepSeek-R1 1.5B",
        "category": "reasoning",
        "size_label": "~1.1 GB",
        "tier": "ultra_light",
        "description": "Compact step-by-step reasoning model for debugging.",
    },
    # Standard (4-8 GiB VRAM or 8-15 GiB RAM)
    {
        "name": "qwen2.5-coder:3b",
        "label": "Qwen 2.5 Coder 3B",
        "category": "coding",
        "size_label": "~1.9 GB",
        "tier": "standard",
        "description": "Balanced code generation, patches, and Python explanations.",
    },
    {
        "name": "qwen3:4b",
        "label": "Qwen 3 4B",
        "category": "general",
        "size_label": "~2.6 GB",
        "tier": "standard",
        "description": "Versatile Qwen 3 model for coding, reasoning, and chat.",
    },
    {
        "name": "phi4-mini:3.8b",
        "label": "Phi-4 Mini 3.8B",
        "category": "reasoning",
        "size_label": "~2.5 GB",
        "tier": "standard",
        "description": "Strong logic and STEM/code reasoning in a 3.8B footprint.",
    },
    {
        "name": "gemma3:4b",
        "label": "Gemma 3 4B",
        "category": "general",
        "size_label": "~3.3 GB",
        "tier": "standard",
        "description": "Well-rounded Google Gemma 3 model for 8 GB systems.",
    },
    {
        "name": "llama3.2:3b",
        "label": "Llama 3.2 3B",
        "category": "general",
        "size_label": "~2.0 GB",
        "tier": "standard",
        "description": "Fast Meta Llama 3.2 model for everyday coding help.",
    },
    {
        "name": "starcoder2:3b",
        "label": "StarCoder2 3B",
        "category": "coding",
        "size_label": "~1.7 GB",
        "tier": "standard",
        "description": "Dedicated code completion and multi-language coding model.",
    },
    # Performance (8+ GiB VRAM or 16+ GiB RAM)
    {
        "name": "qwen2.5-coder:7b",
        "label": "Qwen 2.5 Coder 7B",
        "category": "coding",
        "size_label": "~4.7 GB",
        "tier": "performance",
        "description": "Flagship 7B coding model for refactoring and multi-file edits.",
    },
    {
        "name": "qwen3:8b",
        "label": "Qwen 3 8B",
        "category": "general",
        "size_label": "~5.2 GB",
        "tier": "performance",
        "description": "High-accuracy Qwen 3 model for complex coding and architecture.",
    },
    {
        "name": "deepseek-r1:7b",
        "label": "DeepSeek-R1 7B",
        "category": "reasoning",
        "size_label": "~4.7 GB",
        "tier": "performance",
        "description": "Deep reasoning model suited for tough bugs and algorithm design.",
    },
    {
        "name": "llama3.1:8b",
        "label": "Llama 3.1 8B",
        "category": "general",
        "size_label": "~4.9 GB",
        "tier": "performance",
        "description": "Capable 8B general & coding assistant for 16 GB+ machines.",
    },
    {
        "name": "gemma3:12b",
        "label": "Gemma 3 12B",
        "category": "general",
        "size_label": "~8.1 GB",
        "tier": "performance",
        "description": "High-capacity Gemma 3 model for 12 GB+ VRAM or 16 GB+ RAM.",
    },
    {
        "name": "qwen2.5-coder:14b",
        "label": "Qwen 2.5 Coder 14B",
        "category": "coding",
        "size_label": "~9.0 GB",
        "tier": "performance",
        "description": "Heavyweight coding model for high-VRAM GPUs or 24 GB+ RAM.",
    },
    {
        "name": "codellama:7b",
        "label": "CodeLlama 7B",
        "category": "coding",
        "size_label": "~3.8 GB",
        "tier": "performance",
        "description": "Classic Meta CodeLlama 7B for Python and systems code.",
    },
]


def get_hardware_tiers(hardware: dict[str, Any]) -> dict[str, Any]:
    """Return hardware tier categorization, max context budget, and recommended model sets."""
    gpu = hardware.get("gpu", {})
    memory = hardware.get("memory", {})
    ram_bytes = memory.get("total_bytes") or memory.get("available_bytes") or 0
    vram_bytes = gpu.get("vram_total_bytes") or gpu.get("vram_free_bytes") or 0
    has_gpu = bool(gpu.get("present"))

    ram_gib = ram_bytes / _BYTES_PER_GIB if isinstance(ram_bytes, (int, float)) and ram_bytes > 0 else 0.0
    vram_gib = vram_bytes / _BYTES_PER_GIB if isinstance(vram_bytes, (int, float)) and vram_bytes > 0 else 0.0

    if (has_gpu and vram_gib >= 7.5) or ram_gib >= 15.0:
        tier = "performance"
        max_context_chars = 8000
        num_ctx = 8192
    elif (has_gpu and vram_gib >= 3.5) or ram_gib >= 7.5:
        tier = "standard"
        max_context_chars = 4500
        num_ctx = 4096
    else:
        tier = "ultra_light"
        max_context_chars = 2500
        num_ctx = 2048

    def _tier_models(tier_key: str) -> list[str]:
        return [entry["name"] for entry in MODEL_CATALOG if entry["tier"] == tier_key]

    def _tier_items(tier_key: str) -> list[dict[str, Any]]:
        return [dict(entry) for entry in MODEL_CATALOG if entry["tier"] == tier_key]

    return {
        "tier": tier,
        "max_context_chars": max_context_chars,
        "num_ctx": num_ctx,
        "ram_gib": round(ram_gib, 1),
        "vram_gib": round(vram_gib, 1),
        "catalog": [dict(entry) for entry in MODEL_CATALOG],
        "tiers": {
            "ultra_light": {
                "label": "Ultra-Light (<4 GB RAM)",
                "models": _tier_models("ultra_light"),
                "items": _tier_items("ultra_light"),
                "description": "Minimal RAM usage, fast responses on low-resource laptops.",
            },
            "standard": {
                "label": "Standard (8 GB RAM / 4 GB VRAM)",
                "models": _tier_models("standard"),
                "items": _tier_items("standard"),
                "description": "Balanced coding, general reasoning, and solid accuracy.",
            },
            "performance": {
                "label": "Performance (16 GB+ RAM / 8 GB+ VRAM)",
                "models": _tier_models("performance"),
                "items": _tier_items("performance"),
                "description": "Full capabilities for refactoring, debugging, and multi-file edits.",
            },
        },
    }


def recommend_model(hardware: dict[str, Any]) -> dict[str, Any]:
    """Recommend optimal coding and general models given detected RAM/GPU."""
    tier_info = get_hardware_tiers(hardware)
    gpu = hardware.get("gpu", {})
    memory = hardware.get("memory", {})
    ram_bytes = memory.get("total_bytes") or memory.get("available_bytes") or 0
    vram_bytes = gpu.get("vram_total_bytes") or gpu.get("vram_free_bytes") or 0
    has_gpu = bool(gpu.get("present"))

    ram_gib = ram_bytes / _BYTES_PER_GIB if isinstance(ram_bytes, (int, float)) and ram_bytes > 0 else 0.0
    vram_gib = vram_bytes / _BYTES_PER_GIB if isinstance(vram_bytes, (int, float)) and vram_bytes > 0 else 0.0

    if has_gpu and vram_gib >= 7.5:
        model = "qwen2.5-coder:7b"
        reason = f"Your system has {vram_gib:.1f} GiB VRAM on {gpu.get('name', 'GPU')}, ideal for 7B-8B models."
        fit = "Comfortable"
        alternatives = ["qwen3:8b", "deepseek-r1:7b", "llama3.1:8b", "gemma3:12b"]
    elif has_gpu and vram_gib >= 3.5:
        model = "qwen2.5-coder:3b"
        reason = f"Your system has {vram_gib:.1f} GiB VRAM on {gpu.get('name', 'GPU')}, fitting 3B-4B models comfortably."
        fit = "Comfortable"
        alternatives = ["qwen3:4b", "phi4-mini:3.8b", "gemma3:4b", "llama3.2:3b"]
    elif ram_gib >= 15.0:
        model = "qwen2.5-coder:7b"
        reason = f"Your system has {ram_gib:.1f} GiB RAM, sufficient to run 7B-8B models on CPU/RAM."
        fit = "Comfortable"
        alternatives = ["qwen3:8b", "deepseek-r1:7b", "llama3.1:8b", "qwen3:4b"]
    elif ram_gib >= 7.5:
        model = "qwen2.5-coder:3b"
        reason = f"Your system has {ram_gib:.1f} GiB RAM, ideal for 3B-4B models."
        fit = "Comfortable"
        alternatives = ["qwen3:4b", "phi4-mini:3.8b", "llama3.2:3b", "gemma3:4b"]
    else:
        model = "qwen2.5-coder:1.5b"
        reason = f"Lightweight model suited for systems with limited memory ({ram_gib:.1f} GiB detected)."
        fit = "Comfortable"
        alternatives = ["qwen3:1.7b", "llama3.2:1b", "gemma3:1b", "deepseek-r1:1.5b"]

    return {
        "model": model,
        "alternatives": alternatives,
        "reason": reason,
        "fit": fit,
        "tier": tier_info["tier"],
        "num_ctx": tier_info["num_ctx"],
        "max_context_chars": tier_info["max_context_chars"],
        "tiers": tier_info["tiers"],
        "catalog": tier_info["catalog"],
    }
