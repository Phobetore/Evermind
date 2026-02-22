"""CLI utility to validate config.yaml and check system readiness.

Usage:
    python -m app.validate_config                    # Validate config.yaml
    python -m app.validate_config --check-dirs       # Also verify directories exist
    python -m app.validate_config --check-ports      # Also verify ports are free
    python -m app.validate_config /path/to/config.yaml  # Custom config path
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

from app.config import AppConfig, load_config


def _check_port_free(host: str, port: int) -> bool:
    """Return True if the given port is free on the host."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def _validate_config(cfg: AppConfig, *, check_dirs: bool = False, check_ports: bool = False) -> list[str]:
    """Validate the loaded configuration, returning a list of issues found."""
    issues: list[str] = []

    # Validate LLM server config
    if not cfg.llm_servers:
        issues.append("No LLM servers configured in 'llm_servers'")

    seen_ports: dict[int, str] = {}
    for name, server in cfg.llm_servers.items():
        if server.port in seen_ports:
            issues.append(
                f"Port conflict: servers '{seen_ports[server.port]}' and '{name}' "
                f"both use port {server.port}"
            )
        seen_ports[server.port] = name

        if server.ctx < 512:
            issues.append(f"Server '{name}': ctx ({server.ctx}) is very low (< 512)")

        if check_dirs:
            model_path = Path(server.model_path)
            if not model_path.is_file():
                issues.append(f"Server '{name}': model file not found: {server.model_path}")

        if check_ports and not _check_port_free(cfg.bind_host, server.port):
            issues.append(f"Server '{name}': port {server.port} is already in use")

    # Validate profiles reference existing servers
    for profile_name, profile in cfg.profiles.items():
        for attr in ("chat_server", "memory_server", "judge_server"):
            server_ref = getattr(profile, attr)
            if server_ref not in cfg.llm_servers:
                issues.append(
                    f"Profile '{profile_name}': references unknown server '{server_ref}' in '{attr}'"
                )

        if profile.best_of_n < 1:
            issues.append(f"Profile '{profile_name}': best_of_n must be >= 1")

    # Validate ports
    if check_ports:
        if not _check_port_free(cfg.bind_host, cfg.backend_port):
            issues.append(f"Backend port {cfg.backend_port} is already in use")
        if not _check_port_free(cfg.bind_host, cfg.frontend_port):
            issues.append(f"Frontend port {cfg.frontend_port} is already in use")

    # Check backend/frontend port conflicts with LLM servers
    all_ports = [cfg.backend_port, cfg.frontend_port] + [s.port for s in cfg.llm_servers.values()]
    if len(all_ports) != len(set(all_ports)):
        issues.append("Port conflict detected between backend/frontend and LLM server ports")

    # Validate embeddings
    if not cfg.embeddings.model_name:
        issues.append("Embeddings model_name is empty")
    if cfg.embeddings.dimension < 1:
        issues.append(f"Embeddings dimension ({cfg.embeddings.dimension}) must be >= 1")

    # Validate logging
    valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
    if cfg.logging.level.upper() not in valid_levels:
        issues.append(f"Invalid logging level: '{cfg.logging.level}' (valid: {valid_levels})")

    if check_dirs:
        log_dir = Path(cfg.logging.dir)
        if not log_dir.is_dir():
            issues.append(f"Log directory does not exist: {cfg.logging.dir}")

    return issues


def main() -> None:
    """Entry point for config validation CLI."""
    config_path: Path | None = None
    check_dirs = False
    check_ports = False

    for arg in sys.argv[1:]:
        if arg == "--check-dirs":
            check_dirs = True
        elif arg == "--check-ports":
            check_ports = True
        elif arg in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        elif not arg.startswith("-"):
            config_path = Path(arg)
        else:
            print(f"Unknown option: {arg}", file=sys.stderr)
            sys.exit(1)

    # Load config
    try:
        cfg = load_config(config_path)
    except Exception as e:
        print(f"ERROR: Failed to load config: {e}", file=sys.stderr)
        sys.exit(1)

    # Validate
    issues = _validate_config(cfg, check_dirs=check_dirs, check_ports=check_ports)

    # Summary
    print(f"Config: {config_path or 'auto-detected'}")
    print(f"Bind:   {cfg.bind_host}")
    print(f"Backend port:  {cfg.backend_port}")
    print(f"Frontend port: {cfg.frontend_port}")
    print(f"LLM servers:   {', '.join(f'{k} (:{v.port})' for k, v in cfg.llm_servers.items())}")
    print(f"Profiles:      {', '.join(cfg.profiles.keys())}")
    print(f"Embeddings:    {cfg.embeddings.model_name} (dim={cfg.embeddings.dimension})")
    print(f"Logging:       {cfg.logging.level} → {cfg.logging.dir}")
    print()

    if issues:
        print(f"ISSUES ({len(issues)}):")
        for issue in issues:
            print(f"  ✘ {issue}")
        sys.exit(1)
    else:
        print("✔ Configuration is valid")
        sys.exit(0)


if __name__ == "__main__":
    main()
