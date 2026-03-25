from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
from datetime import datetime
from pathlib import Path

from backend.logging_utils import rotate_session_logs


ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
BACKEND_DIR = ROOT
FRONTEND_DIR = ROOT / "frontend"


def write_line(log_path: Path, source: str, message: str) -> None:
    timestamp = datetime.now().astimezone().isoformat(timespec="milliseconds")
    line = f"{timestamp} | {source} | {message.rstrip()}\n"
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(line)
    print(line, end="")


def stream_process_output(process: subprocess.Popen[str], source: str, log_path: Path) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        write_line(log_path, source, line)


def main() -> int:
    session_id = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    rotate_session_logs()
    log_path = LOG_DIR / f"session-{session_id}.log"

    env = os.environ.copy()
    env["PEOPLE_MAP_SESSION_ID"] = session_id
    env["PEOPLE_MAP_LOG_FILE"] = str(log_path)

    backend_cmd = [str(ROOT / ".venv" / "Scripts" / "python.exe"), "-m", "uvicorn", "backend.main:app", "--reload"]
    frontend_cmd = ["cmd", "/c", "npm", "run", "dev"]

    write_line(log_path, "launcher", f"session_started session_id={session_id}")
    write_line(log_path, "launcher", f"log_file={log_path}")

    backend = subprocess.Popen(
        backend_cmd,
        cwd=BACKEND_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    frontend = subprocess.Popen(
        frontend_cmd,
        cwd=FRONTEND_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    backend_thread = threading.Thread(
        target=stream_process_output, args=(backend, "backend", log_path), daemon=True
    )
    frontend_thread = threading.Thread(
        target=stream_process_output, args=(frontend, "frontend", log_path), daemon=True
    )
    backend_thread.start()
    frontend_thread.start()

    try:
        while True:
            if backend.poll() is not None:
                write_line(log_path, "launcher", f"backend_exited code={backend.returncode}")
                break
            if frontend.poll() is not None:
                write_line(log_path, "launcher", f"frontend_exited code={frontend.returncode}")
                break
            threading.Event().wait(0.5)
    except KeyboardInterrupt:
        write_line(log_path, "launcher", "shutdown_requested")
    finally:
        for process, name in ((backend, "backend"), (frontend, "frontend")):
            if process.poll() is None:
                process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
            write_line(log_path, "launcher", f"{name}_final_code={process.returncode}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
