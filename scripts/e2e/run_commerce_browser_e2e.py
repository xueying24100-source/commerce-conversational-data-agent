#!/usr/bin/env python3
"""Start a local Next.js server, run the browser gate, and always stop its process tree."""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def wait_for_port(host: str, port: int, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.25)
    raise TimeoutError(f"Timed out waiting for {host}:{port}.")


def stop_process_tree(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        taskkill = shutil.which("taskkill")
        if taskkill:
            subprocess.run(
                [taskkill, "/PID", str(process.pid), "/T", "/F"],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return
        process.terminate()
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3000)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--viewport", default="all")
    parser.add_argument("--flow", default="all")
    parser.add_argument(
        "--server-mode",
        choices=("development", "production"),
        default=os.environ.get("COMMERCE_BROWSER_E2E_SERVER_MODE", "development"),
        help="Use the webpack dev server or the already-built production artifact.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    child_environment = os.environ.copy()
    if child_environment.get("NODE_TLS_REJECT_UNAUTHORIZED") == "0":
        del child_environment["NODE_TLS_REJECT_UNAUTHORIZED"]
    next_command = "start" if args.server_mode == "production" else "dev"
    command = [
        shutil.which("node") or "node",
        str(ROOT / "node_modules" / "next" / "dist" / "bin" / "next"),
        next_command,
        *([] if args.server_mode == "production" else ["--webpack"]),
        "--hostname",
        args.host,
        "--port",
        str(args.port),
    ]
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=child_environment,
        creationflags=creationflags,
        start_new_session=os.name != "nt",
    )
    try:
        wait_for_port(args.host, args.port, args.timeout)
        browser_command = [
            sys.executable,
            str(ROOT / "scripts" / "e2e" / "commerce_browser_e2e.py"),
            "--origin",
            f"http://{args.host}:{args.port}/commerce",
            "--viewport",
            args.viewport,
            "--flow",
            args.flow,
            "--server-mode",
            args.server_mode,
        ]
        return subprocess.run(browser_command, cwd=ROOT, env=child_environment, check=False).returncode
    finally:
        stop_process_tree(process)


if __name__ == "__main__":
    raise SystemExit(main())
