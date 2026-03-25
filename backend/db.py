from __future__ import annotations

import sqlite3
import hashlib
from pathlib import Path
from typing import Any

from .logging_utils import get_logger, log_event


BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "people_map.db"
logger = get_logger("db")


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_event(logger, "db_connect", path=str(DB_PATH))
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS people (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                notes TEXT,
                category TEXT,
                date_of_birth TEXT,
                birth_year INTEGER,
                gender TEXT,
                is_alive INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS person_attributes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                person_id INTEGER NOT NULL,
                attribute_key TEXT NOT NULL,
                attribute_value TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS relationships (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_person_id INTEGER NOT NULL,
                to_person_id INTEGER NOT NULL,
                relation_type TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (from_person_id) REFERENCES people(id) ON DELETE CASCADE,
                FOREIGN KEY (to_person_id) REFERENCES people(id) ON DELETE CASCADE,
                UNIQUE(from_person_id, to_person_id, relation_type)
            );

            CREATE TABLE IF NOT EXISTS relationship_suggestions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_person_id INTEGER NOT NULL,
                to_person_id INTEGER NOT NULL,
                relation_type TEXT NOT NULL,
                suggestion_kind TEXT NOT NULL DEFAULT 'direct',
                options_json TEXT,
                rule_key TEXT NOT NULL,
                reason TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                resolved_at TEXT,
                UNIQUE(from_person_id, to_person_id, relation_type, rule_key)
            );

            CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
            CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_person_id);
            CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_person_id);
            CREATE INDEX IF NOT EXISTS idx_suggestions_status ON relationship_suggestions(status);
            """
        )
        _ensure_people_columns(connection)
    log_event(logger, "db_initialized", path=str(DB_PATH))


def fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    with get_connection() as connection:
        rows = connection.execute(query, params).fetchall()
    log_event(logger, "db_fetch_all", row_count=len(rows), query_signature=_query_signature(query), param_count=len(params))
    return rows


def fetch_one(query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    with get_connection() as connection:
        row = connection.execute(query, params).fetchone()
    log_event(logger, "db_fetch_one", found=row is not None, query_signature=_query_signature(query), param_count=len(params))
    return row


def execute(query: str, params: tuple[Any, ...] = ()) -> int:
    with get_connection() as connection:
        cursor = connection.execute(query, params)
        connection.commit()
        last_row_id = int(cursor.lastrowid)
    log_event(logger, "db_execute", last_row_id=last_row_id, query_signature=_query_signature(query), param_count=len(params))
    return last_row_id


def execute_many(queries: list[tuple[str, tuple[Any, ...]]]) -> None:
    with get_connection() as connection:
        for query, params in queries:
            connection.execute(query, params)
        connection.commit()
    log_event(logger, "db_execute_many", statement_count=len(queries))


def _compact_query(query: str) -> str:
    return " ".join(query.split())


def _query_signature(query: str) -> str:
    compact = _compact_query(query)
    digest = hashlib.sha256(compact.encode("utf-8")).hexdigest()[:12]
    return f"sql_{digest}"


def _ensure_people_columns(connection: sqlite3.Connection) -> None:
    rows = connection.execute("PRAGMA table_info(people)").fetchall()
    existing_columns = {row["name"] for row in rows}
    migrations = {
        "date_of_birth": "ALTER TABLE people ADD COLUMN date_of_birth TEXT",
        "birth_year": "ALTER TABLE people ADD COLUMN birth_year INTEGER",
        "gender": "ALTER TABLE people ADD COLUMN gender TEXT",
        "is_alive": "ALTER TABLE people ADD COLUMN is_alive INTEGER",
    }
    for column_name, statement in migrations.items():
        if column_name not in existing_columns:
            connection.execute(statement)
            log_event(logger, "db_migration_column_added", table="people", column=column_name)

    suggestion_rows = connection.execute("PRAGMA table_info(relationship_suggestions)").fetchall()
    existing_suggestion_columns = {row["name"] for row in suggestion_rows}
    suggestion_migrations = {
        "suggestion_kind": "ALTER TABLE relationship_suggestions ADD COLUMN suggestion_kind TEXT NOT NULL DEFAULT 'direct'",
        "options_json": "ALTER TABLE relationship_suggestions ADD COLUMN options_json TEXT",
    }
    for column_name, statement in suggestion_migrations.items():
        if column_name not in existing_suggestion_columns:
            connection.execute(statement)
            log_event(logger, "db_migration_column_added", table="relationship_suggestions", column=column_name)
