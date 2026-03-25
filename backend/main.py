from __future__ import annotations

import sqlite3
import time

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .db import init_db
from .logging_utils import configure_logging, get_logger, log_event, pii_token
from .models import (
    ClientLogEntry,
    GraphResponse,
    Person,
    PersonCreate,
    PersonUpdate,
    Relationship,
    RelationshipCreate,
    RelationshipUpdate,
    RelationshipSuggestion,
    SuggestionDecision,
)
from .repository import (
    refresh_relationship_suggestions,
    accept_suggestion,
    create_person,
    create_relationship,
    decline_suggestion,
    delete_person,
    delete_relationship,
    get_graph,
    get_person,
    list_pending_suggestions,
    list_people,
    update_person,
    update_relationship,
)
from .session import SESSION_ID, SESSION_LOG_PATH


configure_logging()
logger = get_logger("api")
app = FastAPI(title="People Map API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    refresh_relationship_suggestions()
    log_event(logger, "app_startup", session_id=SESSION_ID, log_file=str(SESSION_LOG_PATH))


@app.middleware("http")
async def log_requests(request: Request, call_next):
    started = time.perf_counter()
    log_event(
        logger,
        "request_started",
        method=request.method,
        path=request.url.path,
        has_query=bool(request.url.query),
    )
    try:
        response = await call_next(request)
    except Exception as error:
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        logger.exception("request_failed method=%s path=%s duration_ms=%s", request.method, request.url.path, duration_ms)
        raise error

    duration_ms = round((time.perf_counter() - started) * 1000, 2)
    log_event(
        logger,
        "request_completed",
        method=request.method,
        path=request.url.path,
        status_code=response.status_code,
        duration_ms=duration_ms,
    )
    return response


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, error: Exception) -> JSONResponse:
    logger.exception("unhandled_exception method=%s path=%s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error. Check the session log file.",
            "session_id": SESSION_ID,
            "log_file": str(SESSION_LOG_PATH),
        },
    )


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "session_id": SESSION_ID, "log_file": str(SESSION_LOG_PATH)}


@app.get("/graph", response_model=GraphResponse)
def read_graph(search: str | None = Query(default=None)) -> GraphResponse:
    return get_graph(search=search)


@app.get("/people", response_model=list[Person])
def read_people(search: str | None = Query(default=None)) -> list[Person]:
    return list_people(search=search)


@app.get("/people/{person_id}", response_model=Person)
def read_person(person_id: int) -> Person:
    person = get_person(person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found.")
    return person


@app.post("/people", response_model=Person, status_code=201)
def create_person_route(payload: PersonCreate) -> Person:
    log_event(logger, "route_create_person")
    return create_person(payload)


@app.put("/people/{person_id}", response_model=Person)
def update_person_route(person_id: int, payload: PersonUpdate) -> Person:
    log_event(logger, "route_update_person", person_ref=pii_token("person", person_id))
    person = update_person(person_id, payload)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found.")
    return person


@app.delete("/people/{person_id}", status_code=204, response_class=Response)
def delete_person_route(person_id: int) -> Response:
    log_event(logger, "route_delete_person", person_ref=pii_token("person", person_id))
    deleted = delete_person(person_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Person not found.")
    return Response(status_code=204)


@app.post("/relationships", response_model=Relationship, status_code=201)
def create_relationship_route(payload: RelationshipCreate) -> Relationship:
    log_event(
        logger,
        "route_create_relationship",
        from_person_ref=pii_token("person", payload.from_person_id),
        to_person_ref=pii_token("person", payload.to_person_id),
        relation_type=payload.relation_type,
    )
    try:
        return create_relationship(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Relationship already exists.") from error


@app.put("/relationships/{relationship_id}", response_model=Relationship)
def update_relationship_route(relationship_id: int, payload: RelationshipUpdate) -> Relationship:
    log_event(logger, "route_update_relationship", relationship_id=relationship_id)
    try:
        relationship = update_relationship(relationship_id, payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="Relationship already exists.") from error

    if relationship is None:
        raise HTTPException(status_code=404, detail="Relationship not found.")
    return relationship


@app.delete("/relationships/{relationship_id}", status_code=204, response_class=Response)
def delete_relationship_route(relationship_id: int) -> Response:
    log_event(logger, "route_delete_relationship", relationship_id=relationship_id)
    deleted = delete_relationship(relationship_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Relationship not found.")
    return Response(status_code=204)


@app.post("/client-logs", status_code=202)
def create_client_log(entry: ClientLogEntry) -> dict[str, str]:
    log_event(
        logger,
        "client_log",
        client_session_id=entry.session_id,
        level=entry.level,
        client_event=entry.event,
        message=entry.message,
        client_meta=entry.meta,
    )
    return {"status": "accepted", "session_id": SESSION_ID}


@app.get("/suggestions", response_model=list[RelationshipSuggestion])
def read_suggestions(person_id: int | None = Query(default=None)) -> list[RelationshipSuggestion]:
    return list_pending_suggestions(person_id=person_id)


@app.post("/suggestions/{suggestion_id}/decision", response_model=RelationshipSuggestion)
def decide_suggestion(suggestion_id: int, payload: SuggestionDecision) -> RelationshipSuggestion:
    log_event(logger, "route_decide_suggestion", suggestion_id=suggestion_id, action=payload.action)
    try:
        if payload.action == "accept":
            suggestion = accept_suggestion(suggestion_id, chosen_relation_type=payload.chosen_relation_type)
        else:
            suggestion = decline_suggestion(suggestion_id)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found.")
    return suggestion
