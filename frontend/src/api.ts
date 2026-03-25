import type { GraphResponse, Person, PersonDraft, Relationship, RelationshipDraft, RelationshipSuggestion } from "./types";


const API_BASE = "http://127.0.0.1:8000";
const CLIENT_SESSION_KEY = "people-map-client-session-id";


function getClientSessionId(): string {
  const existing = window.sessionStorage.getItem(CLIENT_SESSION_KEY);
  if (existing) {
    return existing;
  }
  const created = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  window.sessionStorage.setItem(CLIENT_SESSION_KEY, created);
  return created;
}


export async function sendClientLog(
  event: string,
  message: string,
  level = "info",
  meta?: Record<string, string | number | boolean | null>
): Promise<void> {
  try {
    await fetch(`${API_BASE}/client-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: getClientSessionId(),
        level,
        event,
        message,
        meta: meta ?? {}
      })
    });
  } catch {
    // Avoid infinite logging loops when the backend is unreachable.
  }
}


async function request<T>(path: string, init?: RequestInit): Promise<T> {
  await sendClientLog("request_started", `${init?.method ?? "GET"} ${path}`);
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    ...init
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ detail: "Request failed." }));
    await sendClientLog(
      "request_failed",
      `${init?.method ?? "GET"} ${path} -> ${response.status} ${payload.detail ?? "Request failed."}`,
      "error"
    );
    throw new Error(payload.detail ?? "Request failed.");
  }

  if (response.status === 204) {
    await sendClientLog("request_completed", `${init?.method ?? "GET"} ${path} -> 204`);
    return undefined as T;
  }

  await sendClientLog("request_completed", `${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<T>;
}


export function fetchGraph(search?: string): Promise<GraphResponse> {
  const query = search ? `?search=${encodeURIComponent(search)}` : "";
  return request<GraphResponse>(`/graph${query}`);
}


export function createPerson(payload: PersonDraft): Promise<Person> {
  return request<Person>("/people", {
    method: "POST",
    body: JSON.stringify(serializePersonDraft(payload))
  });
}


export function updatePerson(personId: number, payload: PersonDraft): Promise<Person> {
  return request<Person>(`/people/${personId}`, {
    method: "PUT",
    body: JSON.stringify(serializePersonDraft(payload))
  });
}


export function deletePerson(personId: number): Promise<void> {
  return request<void>(`/people/${personId}`, {
    method: "DELETE"
  });
}


export function createRelationship(payload: RelationshipDraft): Promise<Relationship> {
  return request<Relationship>("/relationships", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      from_person_id: Number(payload.from_person_id),
      to_person_id: Number(payload.to_person_id)
    })
  });
}


export function updateRelationship(relationshipId: number, payload: RelationshipDraft): Promise<Relationship> {
  return request<Relationship>(`/relationships/${relationshipId}`, {
    method: "PUT",
    body: JSON.stringify({
      ...payload,
      from_person_id: Number(payload.from_person_id),
      to_person_id: Number(payload.to_person_id)
    })
  });
}


export function deleteRelationship(relationshipId: number): Promise<void> {
  return request<void>(`/relationships/${relationshipId}`, {
    method: "DELETE"
  });
}


export function fetchSuggestions(personId?: number): Promise<RelationshipSuggestion[]> {
  const query = personId ? `?person_id=${personId}` : "";
  return request<RelationshipSuggestion[]>(`/suggestions${query}`);
}


export function decideSuggestion(
  suggestionId: number,
  action: "accept" | "decline",
  chosenRelationType?: string
): Promise<RelationshipSuggestion> {
  return request<RelationshipSuggestion>(`/suggestions/${suggestionId}/decision`, {
    method: "POST",
    body: JSON.stringify({ action, chosen_relation_type: chosenRelationType ?? null })
  });
}


function serializePersonDraft(payload: PersonDraft) {
  return {
    ...payload,
    date_of_birth: payload.date_of_birth || null,
    birth_year: payload.birth_year ? Number(payload.birth_year) : null,
    gender: payload.gender || null,
    is_alive:
      payload.is_alive === "unknown" ? null : payload.is_alive === "alive",
  };
}
