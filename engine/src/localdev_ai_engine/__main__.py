"""Command-line entry point for the engine foundation."""

from .status import health_status


def main() -> None:
    """Print the engine health status for a local setup check."""

    print(health_status())


if __name__ == "__main__":
    main()
