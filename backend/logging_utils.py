from __future__ import annotations

import json
import logging
import os
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Any


BASE_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = BASE_DIR / "logs"
SESSION_ID = os.environ.get("PEOPLE_MAP_SESSION_ID") or datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
SESSION_LOG_PATH = Path(os.environ.get("PEOPLE_MAP_LOG_FILE") or (LOG_DIR / f"session-{SESSION_ID}.log"))
MAX_SESSION_LOG_FILES = 20


class LocalTimeFormatter(logging.Formatter):
    def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:
        local_dt = datetime.fromtimestamp(record.created).astimezone()
        if datefmt:
            return local_dt.strftime(datefmt)
        return local_dt.isoformat(timespec="milliseconds")


def configure_logging() -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    rotate_session_logs()
    formatter = LocalTimeFormatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s"
    )

    root_logger = logging.getLogger("people_map")
    if root_logger.handlers:
        return root_logger

    root_logger.setLevel(logging.INFO)

    file_handler = logging.FileHandler(SESSION_LOG_PATH, encoding="utf-8")
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)
    root_logger.addHandler(stream_handler)

    root_logger.propagate = False
    root_logger.info("logging_started session_id=%s log_file=%s", SESSION_ID, SESSION_LOG_PATH)
    return root_logger


def get_logger(name: str) -> logging.Logger:
    configure_logging()
    return logging.getLogger(f"people_map.{name}")


def log_event(logger: logging.Logger, event: str, **details: Any) -> None:
    safe_details = json.dumps(_sanitize_details(details), ensure_ascii=True, default=str, sort_keys=True)
    logger.info("%s %s", event, safe_details)


def pii_token(prefix: str, value: Any) -> str:
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]
    return f"{prefix}_{digest}"


def _sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    return {key: _sanitize_value(key, value) for key, value in details.items()}


def _sanitize_value(key: str, value: Any) -> Any:
    lowered_key = key.lower()

    if value is None:
        return None

    if isinstance(value, dict):
        return {child_key: _sanitize_value(child_key, child_value) for child_key, child_value in value.items()}

    if isinstance(value, list):
        return [_sanitize_value(key, item) for item in value]

    if lowered_key in {"name", "message", "reason", "search", "query", "params", "detail"}:
        return _redact_text(value)

    return value


def _redact_text(value: Any) -> dict[str, Any]:
    text = str(value)
    return {
        "redacted": True,
        "length": len(text),
        "fingerprint": pii_token("txt", text),
    }


def rotate_session_logs(max_files: int = MAX_SESSION_LOG_FILES) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_files = sorted(LOG_DIR.glob("session-*.log"), key=lambda path: path.stat().st_mtime, reverse=True)
    for stale_file in log_files[max_files:]:
        try:
            stale_file.unlink()
        except OSError:
            continue
