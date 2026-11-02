from localdev_ai_engine import health_status


def test_package_imports() -> None:
    assert callable(health_status)


def test_health_status_returns_expected_values() -> None:
    assert health_status() == {
        "service": "localdev-ai-engine",
        "status": "ok",
        "version": "0.1.0",
    }


def test_health_status_returns_a_fresh_result() -> None:
    first = health_status()
    first["status"] = "changed"

    assert health_status()["status"] == "ok"
