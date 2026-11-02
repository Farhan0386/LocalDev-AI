"""Engine health and status helpers."""

from typing import Final, TypedDict


class HealthStatus(TypedDict):
    """The stable status response exposed by the engine foundation."""

    service: str
    status: str
    version: str


ENGINE_VERSION: Final = "0.1.0"


def health_status() -> HealthStatus:
    """Return the current in-process engine health status."""

    return {
        "service": "localdev-ai-engine",
        "status": "ok",
        "version": ENGINE_VERSION,
    }
