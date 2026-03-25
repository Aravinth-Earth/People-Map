from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class AttributeInput(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    value: str | None = None

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Attribute key cannot be empty.")
        return cleaned

    @field_validator("value")
    @classmethod
    def normalize_value(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class PersonCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    notes: str | None = None
    category: str | None = None
    date_of_birth: str | None = None
    birth_year: int | None = None
    gender: str | None = None
    is_alive: bool | None = None
    attributes: list[AttributeInput] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Name cannot be empty.")
        return cleaned

    @field_validator("notes", "category", "date_of_birth", "gender")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @field_validator("birth_year")
    @classmethod
    def validate_birth_year(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if value < 1800 or value > 3000:
            raise ValueError("Birth year is out of range.")
        return value


class PersonUpdate(PersonCreate):
    pass


class RelationshipCreate(BaseModel):
    from_person_id: int
    to_person_id: int
    relation_type: str = Field(min_length=1, max_length=120)

    @field_validator("relation_type")
    @classmethod
    def validate_relation_type(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Relation type cannot be empty.")
        return cleaned

    @field_validator("to_person_id")
    @classmethod
    def validate_ids(cls, value: int, info) -> int:
        from_person_id = info.data.get("from_person_id")
        if from_person_id is not None and value == from_person_id:
            raise ValueError("Self-links are not allowed in the MVP.")
        return value


class RelationshipUpdate(RelationshipCreate):
    pass


class PersonAttribute(BaseModel):
    id: int
    key: str
    value: str | None


class Person(BaseModel):
    id: int
    name: str
    notes: str | None
    category: str | None
    date_of_birth: str | None
    birth_year: int | None
    gender: str | None
    is_alive: bool | None
    created_at: str
    updated_at: str
    attributes: list[PersonAttribute] = Field(default_factory=list)


class Relationship(BaseModel):
    id: int
    from_person_id: int
    to_person_id: int
    relation_type: str
    created_at: str
    updated_at: str


class GraphResponse(BaseModel):
    people: list[Person]
    relationships: list[Relationship]


class RelationshipSuggestion(BaseModel):
    id: int
    from_person_id: int
    to_person_id: int
    relation_type: str
    suggestion_kind: str
    options: list[str] = Field(default_factory=list)
    rule_key: str
    reason: str
    status: str
    created_at: str
    updated_at: str
    resolved_at: str | None


class SuggestionDecision(BaseModel):
    action: str = Field(min_length=1, max_length=20)
    chosen_relation_type: str | None = None

    @field_validator("action")
    @classmethod
    def validate_action(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if cleaned not in {"accept", "decline"}:
            raise ValueError("Action must be accept or decline.")
        return cleaned

    @field_validator("chosen_relation_type")
    @classmethod
    def normalize_chosen_relation_type(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip().lower()
        return cleaned or None


class ClientLogEntry(BaseModel):
    session_id: str = Field(min_length=1, max_length=120)
    level: str = Field(default="info", min_length=1, max_length=20)
    event: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=500)
    meta: dict[str, int | float | str | bool | None] = Field(default_factory=dict)
