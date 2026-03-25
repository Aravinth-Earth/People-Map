from __future__ import annotations

import json
import sqlite3

from . import db
from .logging_utils import get_logger, log_event, pii_token
from .models import (
    AttributeInput,
    GraphResponse,
    Person,
    PersonAttribute,
    PersonCreate,
    PersonUpdate,
    Relationship,
    RelationshipCreate,
    RelationshipUpdate,
    RelationshipSuggestion,
)


logger = get_logger("repository")


def _person_attributes(person_id: int) -> list[PersonAttribute]:
    rows = db.fetch_all(
        """
        SELECT id, attribute_key, attribute_value
        FROM person_attributes
        WHERE person_id = ?
        ORDER BY attribute_key COLLATE NOCASE, id
        """,
        (person_id,),
    )
    return [
        PersonAttribute(id=row["id"], key=row["attribute_key"], value=row["attribute_value"])
        for row in rows
    ]


def _build_person(row: sqlite3.Row) -> Person:
    return Person(
        id=row["id"],
        name=row["name"],
        notes=row["notes"],
        category=row["category"],
        date_of_birth=row["date_of_birth"],
        birth_year=row["birth_year"],
        gender=row["gender"],
        is_alive=_normalize_is_alive(row["is_alive"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        attributes=_person_attributes(int(row["id"])),
    )


def list_people(search: str | None = None) -> list[Person]:
    if search:
        rows = db.fetch_all(
            """
            SELECT id, name, notes, category, date_of_birth, birth_year, gender, is_alive, created_at, updated_at
            FROM people
            WHERE name LIKE ?
            ORDER BY name COLLATE NOCASE, id
            """,
            (f"%{search.strip()}%",),
        )
    else:
        rows = db.fetch_all(
            """
            SELECT id, name, notes, category, date_of_birth, birth_year, gender, is_alive, created_at, updated_at
            FROM people
            ORDER BY name COLLATE NOCASE, id
            """
        )
    people = [_build_person(row) for row in rows]
    log_event(logger, "list_people", search=search, count=len(people))
    return people


def get_person(person_id: int) -> Person | None:
    row = db.fetch_one(
        """
        SELECT id, name, notes, category, date_of_birth, birth_year, gender, is_alive, created_at, updated_at
        FROM people
        WHERE id = ?
        """,
        (person_id,),
    )
    if row is None:
        log_event(logger, "get_person_missing", person_id=person_id)
        return None
    person = _build_person(row)
    log_event(logger, "get_person", person_id=person_id)
    return person


def create_person(payload: PersonCreate) -> Person:
    person_id = db.execute(
        """
        INSERT INTO people (name, notes, category, date_of_birth, birth_year, gender, is_alive)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payload.name,
            payload.notes,
            payload.category,
            payload.date_of_birth,
            payload.birth_year,
            payload.gender,
            _serialize_is_alive(payload.is_alive),
        ),
    )
    _replace_attributes(person_id, payload.attributes)
    person = get_person(person_id)
    if person is None:
        raise RuntimeError("Failed to load created person.")
    log_event(logger, "create_person", person_ref=_person_ref(person.id))
    return person


def update_person(person_id: int, payload: PersonUpdate) -> Person | None:
    existing = db.fetch_one("SELECT id FROM people WHERE id = ?", (person_id,))
    if existing is None:
        log_event(logger, "update_person_missing", person_id=person_id)
        return None

    db.execute(
        """
        UPDATE people
        SET name = ?, notes = ?, category = ?, date_of_birth = ?, birth_year = ?, gender = ?, is_alive = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (
            payload.name,
            payload.notes,
            payload.category,
            payload.date_of_birth,
            payload.birth_year,
            payload.gender,
            _serialize_is_alive(payload.is_alive),
            person_id,
        ),
    )
    _replace_attributes(person_id, payload.attributes)
    person = get_person(person_id)
    log_event(logger, "update_person", person_ref=_person_ref(person_id))
    return person


def delete_person(person_id: int) -> bool:
    existing = db.fetch_one("SELECT id FROM people WHERE id = ?", (person_id,))
    if existing is None:
        log_event(logger, "delete_person_missing", person_id=person_id)
        return False
    db.execute("DELETE FROM people WHERE id = ?", (person_id,))
    refresh_relationship_suggestions()
    log_event(logger, "delete_person", person_ref=_person_ref(person_id))
    return True


def _replace_attributes(person_id: int, attributes: list[AttributeInput]) -> None:
    queries: list[tuple[str, tuple[object, ...]]] = [
        ("DELETE FROM person_attributes WHERE person_id = ?", (person_id,))
    ]
    for attribute in attributes:
        if not attribute.key:
            continue
        queries.append(
            (
                """
                INSERT INTO person_attributes (person_id, attribute_key, attribute_value)
                VALUES (?, ?, ?)
                """,
                (person_id, attribute.key, attribute.value),
            )
        )
    queries.append(
        ("UPDATE people SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (person_id,))
    )
    db.execute_many(queries)


def list_relationships() -> list[Relationship]:
    rows = db.fetch_all(
        """
        SELECT id, from_person_id, to_person_id, relation_type, created_at, updated_at
        FROM relationships
        ORDER BY updated_at DESC, id DESC
        """
    )
    relationships = [
        Relationship(
            id=row["id"],
            from_person_id=row["from_person_id"],
            to_person_id=row["to_person_id"],
            relation_type=row["relation_type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
        for row in rows
    ]
    log_event(logger, "list_relationships", count=len(relationships))
    return relationships


def create_relationship(payload: RelationshipCreate) -> Relationship:
    _ensure_people_exist(payload.from_person_id, payload.to_person_id)
    relationship_id = db.execute(
        """
        INSERT INTO relationships (from_person_id, to_person_id, relation_type)
        VALUES (?, ?, ?)
        """,
        (payload.from_person_id, payload.to_person_id, payload.relation_type),
    )
    relationship = get_relationship(relationship_id)
    if relationship is None:
        raise RuntimeError("Failed to load created relationship.")
    refresh_relationship_suggestions()
    log_event(
        logger,
        "create_relationship",
        relationship_id=relationship.id,
        from_person_ref=_person_ref(relationship.from_person_id),
        to_person_ref=_person_ref(relationship.to_person_id),
        relation_type=relationship.relation_type,
    )
    return relationship


def get_relationship(relationship_id: int) -> Relationship | None:
    row = db.fetch_one(
        """
        SELECT id, from_person_id, to_person_id, relation_type, created_at, updated_at
        FROM relationships
        WHERE id = ?
        """,
        (relationship_id,),
    )
    if row is None:
        log_event(logger, "get_relationship_missing", relationship_id=relationship_id)
        return None
    relationship = Relationship(
        id=row["id"],
        from_person_id=row["from_person_id"],
        to_person_id=row["to_person_id"],
        relation_type=row["relation_type"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
    log_event(logger, "get_relationship", relationship_id=relationship_id)
    return relationship


def update_relationship(relationship_id: int, payload: RelationshipUpdate) -> Relationship | None:
    _ensure_people_exist(payload.from_person_id, payload.to_person_id)
    existing = db.fetch_one("SELECT id FROM relationships WHERE id = ?", (relationship_id,))
    if existing is None:
        log_event(logger, "update_relationship_missing", relationship_id=relationship_id)
        return None
    db.execute(
        """
        UPDATE relationships
        SET from_person_id = ?, to_person_id = ?, relation_type = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (payload.from_person_id, payload.to_person_id, payload.relation_type, relationship_id),
    )
    relationship = get_relationship(relationship_id)
    refresh_relationship_suggestions()
    log_event(logger, "update_relationship", relationship_id=relationship_id)
    return relationship


def delete_relationship(relationship_id: int) -> bool:
    existing = db.fetch_one("SELECT id FROM relationships WHERE id = ?", (relationship_id,))
    if existing is None:
        log_event(logger, "delete_relationship_missing", relationship_id=relationship_id)
        return False
    db.execute("DELETE FROM relationships WHERE id = ?", (relationship_id,))
    refresh_relationship_suggestions()
    log_event(logger, "delete_relationship", relationship_id=relationship_id)
    return True


def get_graph(search: str | None = None) -> GraphResponse:
    graph = GraphResponse(people=list_people(search=search), relationships=list_relationships())
    log_event(logger, "get_graph", search=search, people=len(graph.people), relationships=len(graph.relationships))
    return graph


def _ensure_people_exist(from_person_id: int, to_person_id: int) -> None:
    for person_id in (from_person_id, to_person_id):
        row = db.fetch_one("SELECT id FROM people WHERE id = ?", (person_id,))
    if row is None:
        log_event(logger, "ensure_people_exist_failed", person_ref=_person_ref(person_id))
        raise ValueError(f"Person {person_id} does not exist.")


def list_pending_suggestions(person_id: int | None = None) -> list[RelationshipSuggestion]:
    if person_id is None:
        rows = db.fetch_all(
            """
            SELECT id, from_person_id, to_person_id, relation_type, suggestion_kind, options_json, rule_key, reason, status, created_at, updated_at, resolved_at
            FROM relationship_suggestions
            WHERE status = 'pending'
            ORDER BY updated_at DESC, id DESC
            """
        )
    else:
        rows = db.fetch_all(
            """
            SELECT id, from_person_id, to_person_id, relation_type, suggestion_kind, options_json, rule_key, reason, status, created_at, updated_at, resolved_at
            FROM relationship_suggestions
            WHERE status = 'pending' AND (from_person_id = ? OR to_person_id = ?)
            ORDER BY updated_at DESC, id DESC
            """,
            (person_id, person_id),
        )
    suggestions = [_build_suggestion(row) for row in rows]
    log_event(logger, "list_pending_suggestions", person_id=person_id, count=len(suggestions))
    return suggestions


def accept_suggestion(suggestion_id: int, chosen_relation_type: str | None = None) -> RelationshipSuggestion | None:
    suggestion = get_suggestion(suggestion_id)
    if suggestion is None:
        log_event(logger, "accept_suggestion_missing", suggestion_id=suggestion_id)
        return None
    if suggestion.status != "pending":
        log_event(logger, "accept_suggestion_skipped", suggestion_id=suggestion_id, status=suggestion.status)
        return suggestion

    final_relation_type = chosen_relation_type or suggestion.relation_type
    if suggestion.suggestion_kind == "clarify" and not final_relation_type:
        raise ValueError("Clarification suggestions require a chosen relation type.")
    if suggestion.suggestion_kind == "clarify" and suggestion.options and final_relation_type not in suggestion.options:
        raise ValueError("Chosen relation type is not allowed for this suggestion.")

    existing = db.fetch_one(
        """
        SELECT id FROM relationships
        WHERE from_person_id = ? AND to_person_id = ? AND relation_type = ?
        """,
        (suggestion.from_person_id, suggestion.to_person_id, final_relation_type),
    )
    if existing is None:
        db.execute(
            """
            INSERT INTO relationships (from_person_id, to_person_id, relation_type)
            VALUES (?, ?, ?)
            """,
            (suggestion.from_person_id, suggestion.to_person_id, final_relation_type),
        )

    db.execute(
        """
        UPDATE relationship_suggestions
        SET relation_type = ?, status = 'accepted', updated_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (final_relation_type, suggestion_id),
    )
    refresh_relationship_suggestions()
    updated = get_suggestion(suggestion_id)
    log_event(logger, "accept_suggestion", suggestion_id=suggestion_id, chosen_relation_type=final_relation_type)
    return updated


def decline_suggestion(suggestion_id: int) -> RelationshipSuggestion | None:
    suggestion = get_suggestion(suggestion_id)
    if suggestion is None:
        log_event(logger, "decline_suggestion_missing", suggestion_id=suggestion_id)
        return None
    db.execute(
        """
        UPDATE relationship_suggestions
        SET status = 'declined', updated_at = CURRENT_TIMESTAMP, resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (suggestion_id,),
    )
    updated = get_suggestion(suggestion_id)
    log_event(logger, "decline_suggestion", suggestion_id=suggestion_id)
    return updated


def get_suggestion(suggestion_id: int) -> RelationshipSuggestion | None:
    row = db.fetch_one(
        """
        SELECT id, from_person_id, to_person_id, relation_type, suggestion_kind, options_json, rule_key, reason, status, created_at, updated_at, resolved_at
        FROM relationship_suggestions
        WHERE id = ?
        """,
        (suggestion_id,),
    )
    if row is None:
        return None
    return _build_suggestion(row)


def refresh_relationship_suggestions() -> None:
    relationships = list_relationships()
    people = {person.id: person for person in list_people()}

    active_keys = {
        (relationship.from_person_id, relationship.to_person_id, relationship.relation_type.lower())
        for relationship in relationships
    }

    candidate_map: dict[tuple[int, int, str, str], dict[str, object]] = {}
    siblings = [_canonical_sibling_pair(relationship) for relationship in relationships if _is_sibling_relation(relationship.relation_type)]
    siblings = [pair for pair in siblings if pair is not None]

    parent_edges = [_canonical_parent_edge(relationship, people) for relationship in relationships]
    parent_edges = [edge for edge in parent_edges if edge is not None]

    for sibling_pair in siblings:
        sibling_a, sibling_b = sibling_pair
        for parent_id, child_id, relation_type in parent_edges:
            if child_id == sibling_a:
                _add_suggestion_candidate(
                    candidate_map,
                    active_keys,
                    from_person_id=parent_id,
                    to_person_id=sibling_b,
                    relation_type=relation_type,
                    suggestion_kind="direct",
                    options=[],
                    rule_key=f"shared_parent_v1:{relation_type}",
                    reason=f"{people[parent_id].name} is already linked as {relation_type} of {people[sibling_a].name}, and {people[sibling_a].name} is a sibling of {people[sibling_b].name}.",
                )
            elif child_id == sibling_b:
                _add_suggestion_candidate(
                    candidate_map,
                    active_keys,
                    from_person_id=parent_id,
                    to_person_id=sibling_a,
                    relation_type=relation_type,
                    suggestion_kind="direct",
                    options=[],
                    rule_key=f"shared_parent_v1:{relation_type}",
                    reason=f"{people[parent_id].name} is already linked as {relation_type} of {people[sibling_b].name}, and {people[sibling_b].name} is a sibling of {people[sibling_a].name}.",
                )

    spouse_edges = [_canonical_spouse_pair(relationship) for relationship in relationships]
    spouse_edges = [edge for edge in spouse_edges if edge is not None]

    for spouse_a, spouse_b in spouse_edges:
        for parent_id, child_id, relation_type in parent_edges:
            if parent_id == spouse_a:
                options = _clarification_options_for_parent_relation(relation_type)
                _add_suggestion_candidate(
                    candidate_map,
                    active_keys,
                    from_person_id=spouse_b,
                    to_person_id=child_id,
                    relation_type=options[0],
                    suggestion_kind="clarify",
                    options=options,
                    rule_key=f"spouse_parent_clarify_v1:{relation_type}",
                    reason=f"{people[spouse_b].name} is spouse of {people[spouse_a].name}, and {people[spouse_a].name} is {relation_type} of {people[child_id].name}. How is {people[spouse_b].name} related to {people[child_id].name}?",
                )
            elif parent_id == spouse_b:
                options = _clarification_options_for_parent_relation(relation_type)
                _add_suggestion_candidate(
                    candidate_map,
                    active_keys,
                    from_person_id=spouse_a,
                    to_person_id=child_id,
                    relation_type=options[0],
                    suggestion_kind="clarify",
                    options=options,
                    rule_key=f"spouse_parent_clarify_v1:{relation_type}",
                    reason=f"{people[spouse_a].name} is spouse of {people[spouse_b].name}, and {people[spouse_b].name} is {relation_type} of {people[child_id].name}. How is {people[spouse_a].name} related to {people[child_id].name}?",
                )

    for (from_person_id, to_person_id, relation_type, rule_key), payload in candidate_map.items():
        db.execute(
            """
            INSERT INTO relationship_suggestions (from_person_id, to_person_id, relation_type, suggestion_kind, options_json, rule_key, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
            ON CONFLICT(from_person_id, to_person_id, relation_type, rule_key)
            DO UPDATE SET
                suggestion_kind = excluded.suggestion_kind,
                options_json = excluded.options_json,
                reason = excluded.reason,
                updated_at = CURRENT_TIMESTAMP
            WHERE relationship_suggestions.status = 'pending'
            """,
            (
                from_person_id,
                to_person_id,
                relation_type,
                payload["suggestion_kind"],
                json.dumps(payload["options"]),
                rule_key,
                payload["reason"],
            ),
        )

    _prune_stale_pending_suggestions(candidate_map)
    log_event(logger, "refresh_relationship_suggestions", generated=len(candidate_map))


def _prune_stale_pending_suggestions(candidate_map: dict[tuple[int, int, str, str], dict[str, object]]) -> None:
    rows = db.fetch_all(
        """
        SELECT id, from_person_id, to_person_id, relation_type, rule_key
        FROM relationship_suggestions
        WHERE status = 'pending'
        """
    )
    for row in rows:
        key = (row["from_person_id"], row["to_person_id"], row["relation_type"], row["rule_key"])
        if key not in candidate_map:
            db.execute("DELETE FROM relationship_suggestions WHERE id = ?", (row["id"],))


def _add_suggestion_candidate(
    candidate_map: dict[tuple[int, int, str, str], dict[str, object]],
    active_keys: set[tuple[int, int, str]],
    *,
    from_person_id: int,
    to_person_id: int,
    relation_type: str,
    suggestion_kind: str,
    options: list[str],
    rule_key: str,
    reason: str,
) -> None:
    if from_person_id == to_person_id:
        return
    active_key = (from_person_id, to_person_id, relation_type.lower())
    if active_key in active_keys:
        return
    candidate_map[(from_person_id, to_person_id, relation_type, rule_key)] = {
        "suggestion_kind": suggestion_kind,
        "options": options,
        "reason": reason,
    }


def _is_sibling_relation(relation_type: str) -> bool:
    return relation_type.strip().lower() in {"brother", "sister", "sibling"}


def _canonical_sibling_pair(relationship: Relationship) -> tuple[int, int] | None:
    if relationship.from_person_id == relationship.to_person_id:
        return None
    low, high = sorted([relationship.from_person_id, relationship.to_person_id])
    return (low, high)


def _canonical_parent_edge(relationship: Relationship, people: dict[int, Person]) -> tuple[int, int, str] | None:
    relation_type = relationship.relation_type.strip().lower()
    if relation_type in {"mother", "father", "parent"}:
        if relationship.from_person_id not in people or relationship.to_person_id not in people:
            return None
        return (relationship.from_person_id, relationship.to_person_id, relation_type)
    if relation_type in {"son", "daughter", "child"}:
        if relationship.from_person_id not in people or relationship.to_person_id not in people:
            return None
        inferred_parent_type = _parent_relation_for_person(people[relationship.to_person_id])
        return (relationship.to_person_id, relationship.from_person_id, inferred_parent_type)
    return None


def _canonical_spouse_pair(relationship: Relationship) -> tuple[int, int] | None:
    if relationship.relation_type.strip().lower() != "spouse":
        return None
    if relationship.from_person_id == relationship.to_person_id:
        return None
    return (relationship.from_person_id, relationship.to_person_id)


def _clarification_options_for_parent_relation(relation_type: str) -> list[str]:
    if relation_type == "mother":
        return ["father", "stepfather", "guardian"]
    if relation_type == "father":
        return ["mother", "stepmother", "guardian"]
    return ["parent", "guardian"]


def _parent_relation_for_person(person: Person) -> str:
    gender = (person.gender or "").strip().lower()
    if gender == "male":
        return "father"
    if gender == "female":
        return "mother"
    return "parent"
def _build_suggestion(row: sqlite3.Row) -> RelationshipSuggestion:
    options_json = row["options_json"] or "[]"
    return RelationshipSuggestion(
        id=row["id"],
        from_person_id=row["from_person_id"],
        to_person_id=row["to_person_id"],
        relation_type=row["relation_type"],
        suggestion_kind=row["suggestion_kind"],
        options=list(json.loads(options_json)),
        rule_key=row["rule_key"],
        reason=row["reason"],
        status=row["status"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        resolved_at=row["resolved_at"],
    )


def _normalize_is_alive(value: int | None) -> bool | None:
    if value is None:
        return None
    return bool(value)


def _serialize_is_alive(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _person_ref(person_id: int) -> str:
    return pii_token("person", person_id)
