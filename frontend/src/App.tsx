import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useNodesInitialized,
  type Edge,
  type Node,
  type NodeProps,
  type OnEdgesChange,
  type OnNodesChange
} from "@xyflow/react";
import {
  createPerson,
  createRelationship,
  decideSuggestion,
  deletePerson,
  deleteRelationship,
  fetchGraph,
  fetchSuggestions,
  sendClientLog,
  updatePerson,
  updateRelationship
} from "./api";
import {
  CUSTOM_RELATION_VALUE,
  RELATION_OPTIONS,
  isFamilyRelation,
  isKnownRelation,
  normalizeRelation,
  relationVisualGroup
} from "./relations";
import type { Attribute, GraphResponse, Person, PersonDraft, Relationship, RelationshipDraft, RelationshipSuggestion } from "./types";


const EMPTY_PERSON: PersonDraft = {
  name: "",
  notes: "",
  category: "",
  date_of_birth: "",
  birth_year: "",
  gender: "",
  is_alive: "unknown",
  attributes: []
};

const EMPTY_RELATIONSHIP: RelationshipDraft = {
  from_person_id: "",
  to_person_id: "",
  relation_choice: "",
  relation_type: ""
};

const EMPTY_CREATE_LINK = {
  existing_person_id: "",
  relation_choice: "",
  relation_type: "",
  direction: "new_to_existing"
} as const;

type CreateLinkDraft = {
  existing_person_id: string;
  relation_choice: string;
  relation_type: string;
  direction: "new_to_existing" | "existing_to_new";
};

type PersonNodeData = {
  label: ReactNode;
  category: string | null;
};

function PersonNode({ data }: NodeProps<Node<PersonNodeData>>) {
  return (
    <>
      <Handle className="person-handle top" type="target" position={Position.Top} id="top-target" />
      <Handle className="person-handle top" type="source" position={Position.Top} id="top-source" />
      <Handle className="person-handle right" type="target" position={Position.Right} id="right-target" />
      <Handle className="person-handle right" type="source" position={Position.Right} id="right-source" />
      <Handle className="person-handle bottom" type="target" position={Position.Bottom} id="bottom-target" />
      <Handle className="person-handle bottom" type="source" position={Position.Bottom} id="bottom-source" />
      <Handle className="person-handle left" type="target" position={Position.Left} id="left-target" />
      <Handle className="person-handle left" type="source" position={Position.Left} id="left-source" />
      {data.label}
    </>
  );
}

function App() {
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const [graph, setGraph] = useState<GraphResponse>({ people: [], relationships: [] });
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [shouldFitViewport, setShouldFitViewport] = useState(false);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [selectedRelationshipId, setSelectedRelationshipId] = useState<number | null>(null);
  const [createDraft, setCreateDraft] = useState<PersonDraft>(EMPTY_PERSON);
  const [editDraft, setEditDraft] = useState<PersonDraft>(EMPTY_PERSON);
  const [relationshipDraft, setRelationshipDraft] = useState<RelationshipDraft>(EMPTY_RELATIONSHIP);
  const [createLink, setCreateLink] = useState<CreateLinkDraft>({
    existing_person_id: "",
    relation_choice: "",
    relation_type: "",
    direction: "new_to_existing"
  });
  const [createNameError, setCreateNameError] = useState("");
  const [editNameError, setEditNameError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("Loading graph...");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<RelationshipSuggestion[]>([]);
  const [suggestionChoices, setSuggestionChoices] = useState<Record<number, string>>({});
  const [graphDebug, setGraphDebug] = useState({
    nodes: 0,
    edges: 0,
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    viewport: { x: 0, y: 0, zoom: 1 },
    initialized: false
  });
  const lastDiagnosticsKey = useRef("");
  const nodeTypes = useMemo(() => ({ personNode: PersonNode }), []);

  const selectedPerson = useMemo(
    () => graph.people.find((person) => person.id === selectedPersonId) ?? null,
    [graph.people, selectedPersonId]
  );

  const selectedRelationship = useMemo(
    () => graph.relationships.find((relationship) => relationship.id === selectedRelationshipId) ?? null,
    [graph.relationships, selectedRelationshipId]
  );

  const graphDiagnosticsKey = useMemo(
    () =>
      JSON.stringify({
        people: graph.people.map((person) => person.id).sort((left, right) => left - right),
        relationships: graph.relationships.map((relationship) => relationship.id).sort((left, right) => left - right)
      }),
    [graph.people, graph.relationships]
  );

  const visibleRelationships = useMemo(() => graph.relationships, [graph.relationships]);

  useEffect(() => {
    void sendClientLog("app_loaded", "Frontend app mounted.");
    void loadGraph();
  }, []);

  useEffect(() => {
    const nextNodes = buildNodes(graph.people, selectedPersonId, visibleRelationships);
    setNodes(nextNodes);
    setEdges(buildEdges(visibleRelationships, selectedRelationshipId, nextNodes));
  }, [graph, selectedPersonId, selectedRelationshipId, visibleRelationships]);

  useEffect(() => {
    if (!shouldFitViewport || !nodes.length || !nodesInitialized) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void flow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 0 });
      void flow.fitView({ padding: 0.22, duration: 350, includeHiddenNodes: true });
      setShouldFitViewport(false);
    }, 40);
    return () => window.clearTimeout(timeoutId);
  }, [flow, shouldFitViewport, nodes, nodesInitialized]);

  useEffect(() => {
    if (!nodesInitialized || !nodes.length) {
      return;
    }
    if (lastDiagnosticsKey.current === graphDiagnosticsKey) {
      return;
    }
    lastDiagnosticsKey.current = graphDiagnosticsKey;
    const timeoutId = window.setTimeout(() => {
      const bounds = flow.getNodesBounds(nodes);
      const viewport = flow.getViewport();
      const visibilityIssue =
        !Number.isFinite(bounds.x) ||
        !Number.isFinite(bounds.y) ||
        !Number.isFinite(bounds.width) ||
        !Number.isFinite(bounds.height) ||
        bounds.width <= 0 ||
        bounds.height <= 0;
      const diagnostics = {
        nodes: nodes.length,
        edges: edges.length,
        bounds: {
          x: roundForLog(bounds.x) ?? 0,
          y: roundForLog(bounds.y) ?? 0,
          width: roundForLog(bounds.width) ?? 0,
          height: roundForLog(bounds.height) ?? 0
        },
        viewport: {
          x: roundForLog(viewport.x) ?? 0,
          y: roundForLog(viewport.y) ?? 0,
          zoom: roundForLog(viewport.zoom) ?? 0
        },
        initialized: nodesInitialized
      };
      setGraphDebug(diagnostics);
      void sendClientLog(
        visibilityIssue ? "graph_render_diagnostics_error" : "graph_render_diagnostics",
        "Graph diagnostics snapshot.",
        visibilityIssue ? "error" : "info",
        {
          nodes: diagnostics.nodes,
          edges: diagnostics.edges,
          bounds_x: diagnostics.bounds.x,
          bounds_y: diagnostics.bounds.y,
          bounds_width: diagnostics.bounds.width,
          bounds_height: diagnostics.bounds.height,
          viewport_x: diagnostics.viewport.x,
          viewport_y: diagnostics.viewport.y,
          viewport_zoom: diagnostics.viewport.zoom,
          initialized: diagnostics.initialized
        }
      );
    }, 180);
    return () => window.clearTimeout(timeoutId);
  }, [flow, nodes, edges, nodesInitialized, graphDiagnosticsKey]);

  useEffect(() => {
    if (!selectedPerson) {
      setEditDraft(EMPTY_PERSON);
      return;
    }
    setEditDraft({
      name: selectedPerson.name,
      notes: selectedPerson.notes ?? "",
      category: selectedPerson.category ?? "",
      date_of_birth: selectedPerson.date_of_birth ?? "",
      birth_year: selectedPerson.birth_year ? String(selectedPerson.birth_year) : "",
      gender: selectedPerson.gender ?? "",
      is_alive: selectedPerson.is_alive === null ? "unknown" : selectedPerson.is_alive ? "alive" : "deceased",
      attributes: selectedPerson.attributes.map((attribute) => ({
        id: attribute.id,
        key: attribute.key,
        value: attribute.value
      }))
    });
    setRelationshipDraft((current) => ({
      ...current,
      from_person_id: String(selectedPerson.id)
    }));
  }, [selectedPerson]);

  useEffect(() => {
    if (!selectedRelationship) {
      setRelationshipDraft((current) => ({
        ...EMPTY_RELATIONSHIP,
        from_person_id: current.from_person_id
      }));
      return;
    }
    setRelationshipDraft({
      from_person_id: String(selectedRelationship.from_person_id),
      to_person_id: String(selectedRelationship.to_person_id),
      relation_choice: isKnownRelation(selectedRelationship.relation_type)
        ? selectedRelationship.relation_type
        : CUSTOM_RELATION_VALUE,
      relation_type: selectedRelationship.relation_type
    });
  }, [selectedRelationship]);

  useEffect(() => {
    void loadSuggestions(selectedPersonId ?? undefined);
  }, [selectedPersonId]);

  async function loadGraph(searchTerm?: string) {
    try {
      await sendClientLog("load_graph", searchTerm ? "Loading graph with active search filter." : "Loading graph.");
      const data = await fetchGraph(searchTerm);
      setGraph(data);
      setShouldFitViewport(true);
      setStatus(`Loaded ${data.people.length} people and ${data.relationships.length} relationships.`);
      await loadSuggestions(selectedPersonId ?? undefined);
    } catch (error) {
      await sendClientLog("load_graph_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    }
  }

  async function loadSuggestions(personId?: number) {
    try {
      const data = await fetchSuggestions(personId);
      setSuggestions(data);
      setSuggestionChoices((current) => {
        const next = { ...current };
        for (const suggestion of data) {
          if (!next[suggestion.id]) {
            next[suggestion.id] = suggestion.options[0] ?? suggestion.relation_type;
          }
        }
        return next;
      });
    } catch (error) {
      await sendClientLog("load_suggestions_failed", getErrorMessage(error), "error");
    }
  }

  const onNodesChange: OnNodesChange = (changes) => {
    setNodes((current) => applyNodeChanges(changes, current));
  };

  const onEdgesChange: OnEdgesChange = (changes) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  };

  function handleNodeSelect(_: unknown, node: Node) {
    setSelectedRelationshipId(null);
    setSelectedPersonId(Number(node.id));
    setStatus(`Selected ${personName(graph.people, Number(node.id))}.`);
  }

  function handleEdgeSelect(_: unknown, edge: Edge) {
    setSelectedPersonId(null);
    setSelectedRelationshipId(Number(edge.id));
    setStatus(`Selected relationship: ${String(edge.label)}.`);
  }

  async function handleCreatePerson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanedDraft = cleanPersonDraft(createDraft);
    if (!cleanedDraft.name) {
      setCreateNameError("Name is required.");
      setStatus("Name is required before adding a person.");
      await sendClientLog("create_person_blocked", "Create person blocked because name is missing.", "error");
      return;
    }
    setBusy(true);
    try {
      setCreateNameError("");
      await sendClientLog("create_person_attempt", "Submitting create person form.");
      const person = await createPerson(cleanedDraft);

      if (createLink.existing_person_id && createLink.relation_type.trim()) {
        const existingPersonId = Number(createLink.existing_person_id);
        const newToExisting = createLink.direction === "new_to_existing";
        await createRelationship({
          from_person_id: String(newToExisting ? person.id : existingPersonId),
          to_person_id: String(newToExisting ? existingPersonId : person.id),
          relation_choice: createLink.relation_choice || createLink.relation_type.trim(),
          relation_type: createLink.relation_type.trim()
        });
      }

      await loadGraph(search);
      setSelectedPersonId(person.id);
      setSelectedRelationshipId(null);
      setCreateDraft(EMPTY_PERSON);
      setCreateLink({ ...EMPTY_CREATE_LINK });
      setStatus(`Added ${person.name} to the map.`);
    } catch (error) {
      await sendClientLog("create_person_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdatePerson() {
    if (!selectedPersonId) {
      setStatus("Select a person first.");
      await sendClientLog("update_person_blocked", "No selected person.", "error");
      return;
    }
    const cleanedDraft = cleanPersonDraft(editDraft);
    if (!cleanedDraft.name) {
      setEditNameError("Name is required.");
      setStatus("Name is required before saving.");
      await sendClientLog("update_person_blocked", `Update blocked because name is missing for person_id=${selectedPersonId}.`, "error");
      return;
    }
    setBusy(true);
    try {
      setEditNameError("");
      await sendClientLog("update_person_attempt", `person_id=${selectedPersonId}`);
      await updatePerson(selectedPersonId, cleanedDraft);
      await loadGraph(search);
      setStatus("Person updated.");
    } catch (error) {
      await sendClientLog("update_person_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeletePerson() {
    if (!selectedPersonId || !selectedPerson) {
      setStatus("Select a person first.");
      await sendClientLog("delete_person_blocked", "No selected person.", "error");
      return;
    }
    const confirmed = window.confirm(`Delete ${selectedPerson.name} and all connected relationships?`);
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await sendClientLog("delete_person_attempt", `person_id=${selectedPersonId}`);
      await deletePerson(selectedPersonId);
      setSelectedPersonId(null);
      await loadGraph(search);
      setStatus("Person deleted.");
    } catch (error) {
      await sendClientLog("delete_person_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateRelationship(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      await sendClientLog(
        "create_relationship_attempt",
        "Submitting create relationship form."
      );
      const relationship = await createRelationship(relationshipDraft);
      await loadGraph(search);
      setSelectedRelationshipId(relationship.id);
      setStatus("Relationship added.");
    } catch (error) {
      await sendClientLog("create_relationship_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateRelationship() {
    if (!selectedRelationshipId) {
      setStatus("Select a relationship first.");
      await sendClientLog("update_relationship_blocked", "No selected relationship.", "error");
      return;
    }
    setBusy(true);
    try {
      await sendClientLog("update_relationship_attempt", `relationship_id=${selectedRelationshipId}`);
      await updateRelationship(selectedRelationshipId, relationshipDraft);
      await loadGraph(search);
      setStatus("Relationship updated.");
    } catch (error) {
      await sendClientLog("update_relationship_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRelationship() {
    if (!selectedRelationshipId) {
      setStatus("Select a relationship first.");
      await sendClientLog("delete_relationship_blocked", "No selected relationship.", "error");
      return;
    }
    const confirmed = window.confirm("Delete this relationship?");
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      await sendClientLog("delete_relationship_attempt", `relationship_id=${selectedRelationshipId}`);
      await deleteRelationship(selectedRelationshipId);
      setSelectedRelationshipId(null);
      await loadGraph(search);
      setStatus("Relationship deleted.");
    } catch (error) {
      await sendClientLog("delete_relationship_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleSuggestionDecision(suggestion: RelationshipSuggestion, action: "accept" | "decline") {
    setBusy(true);
    try {
      const chosenRelationType =
        action === "accept" && suggestion.suggestion_kind === "clarify"
          ? suggestionChoices[suggestion.id]
          : undefined;
      await sendClientLog(
        "suggestion_decision_attempt",
        `suggestion_id=${suggestion.id} action=${action}`
      );
      await decideSuggestion(suggestion.id, action, chosenRelationType);
      await loadGraph(search);
      await loadSuggestions(selectedPersonId ?? undefined);
      setStatus(action === "accept" ? "Suggestion accepted." : "Suggestion dismissed.");
    } catch (error) {
      await sendClientLog("suggestion_decision_failed", getErrorMessage(error), "error");
      setStatus(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function addAttributeField(mode: "create" | "edit") {
    const setter = mode === "create" ? setCreateDraft : setEditDraft;
    setter((current) => ({
      ...current,
      attributes: [...current.attributes, { key: "", value: "" }]
    }));
  }

  function updateAttribute(mode: "create" | "edit", index: number, patch: Partial<Attribute>) {
    const setter = mode === "create" ? setCreateDraft : setEditDraft;
    setter((current) => ({
      ...current,
      attributes: current.attributes.map((attribute, attributeIndex) =>
        attributeIndex === index ? { ...attribute, ...patch } : attribute
      )
    }));
  }

  function removeAttribute(mode: "create" | "edit", index: number) {
    const setter = mode === "create" ? setCreateDraft : setEditDraft;
    setter((current) => ({
      ...current,
      attributes: current.attributes.filter((_, attributeIndex) => attributeIndex !== index)
    }));
  }

  async function handleSearchSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadGraph(search);
  }

function resetSelection() {
    setSelectedPersonId(null);
    setSelectedRelationshipId(null);
    setRelationshipDraft(EMPTY_RELATIONSHIP);
    setStatus("Ready.");
  }

  function handleResetLayout() {
    const nextNodes = buildNodes(graph.people, selectedPersonId, visibleRelationships);
    setNodes(nextNodes);
    setEdges(buildEdges(visibleRelationships, selectedRelationshipId, nextNodes));
    setShouldFitViewport(true);
    void sendClientLog("reset_layout", "Reset node positions to generated layout and requested fit view.");
    setStatus("Layout reset.");
  }

  function handleRelationshipChoiceChange(value: string) {
    setRelationshipDraft((current) => ({
      ...current,
      relation_choice: value,
      relation_type: value === CUSTOM_RELATION_VALUE ? current.relation_type : value
    }));
  }

  function handleCreateLinkChoiceChange(value: string) {
    setCreateLink((current) => ({
      ...current,
      relation_choice: value,
      relation_type: value === CUSTOM_RELATION_VALUE ? current.relation_type : value
    }));
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="panel hero-panel">
          <p className="eyebrow">Personal People Map</p>
          <h1>Dark graph, fast editing, live updates</h1>
          <p className="hero-copy">
            Add people, link them immediately, and keep the map visible while you work.
          </p>
          <button className="ghost-button" type="button" onClick={resetSelection}>
            Clear selection
          </button>
        </header>

        <section className="panel">
          <div className="section-title-row">
            <h2>Search</h2>
            <span>{graph.people.length} visible</span>
          </div>
          <form className="stack" onSubmit={handleSearchSubmit}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find by name"
            />
            <button disabled={busy} type="submit">
              Search graph
            </button>
          </form>
        </section>

        <section className="panel accent-panel">
          <div className="section-title-row">
            <h2>Add Person</h2>
            <span>Always available</span>
          </div>
          <form className="stack" onSubmit={handleCreatePerson}>
            <label>
              <span>Name</span>
              <input
                className={createNameError ? "field-error-input" : undefined}
                value={createDraft.name}
                onChange={(event) => {
                  setCreateDraft((current) => ({ ...current, name: event.target.value }));
                  if (event.target.value.trim()) {
                    setCreateNameError("");
                  }
                }}
                placeholder="Name"
              />
              {createNameError ? <small className="field-error-text">{createNameError}</small> : null}
            </label>
            <label>
              <span>Category</span>
              <input
                value={createDraft.category}
                onChange={(event) => setCreateDraft((current) => ({ ...current, category: event.target.value }))}
                placeholder="family, work, school..."
              />
            </label>
            <div className="meta-grid">
              <label>
                <span>DOB</span>
                <input
                  type="date"
                  value={createDraft.date_of_birth}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, date_of_birth: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>YOB</span>
                <input
                  inputMode="numeric"
                  value={createDraft.birth_year}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, birth_year: event.target.value }))
                  }
                  placeholder="1998"
                />
              </label>
            </div>
            <div className="meta-grid">
              <label>
                <span>Gender</span>
                <select
                  value={createDraft.gender}
                  onChange={(event) =>
                    setCreateDraft((current) => ({ ...current, gender: event.target.value }))
                  }
                >
                  <option value="">Unspecified</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                <span>Status</span>
                <select
                  value={createDraft.is_alive}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      is_alive: event.target.value as "alive" | "deceased" | "unknown"
                    }))
                  }
                >
                  <option value="unknown">Unknown</option>
                  <option value="alive">Alive</option>
                  <option value="deceased">Deceased</option>
                </select>
              </label>
            </div>
            <label>
              <span>Notes</span>
              <textarea
                value={createDraft.notes}
                onChange={(event) => setCreateDraft((current) => ({ ...current, notes: event.target.value }))}
                placeholder="Short notes"
                rows={3}
              />
            </label>

            <div className="attributes-block">
              <div className="section-title-row">
                <h3>Attributes</h3>
                <button className="mini-button" type="button" onClick={() => addAttributeField("create")}>
                  Add field
                </button>
              </div>
              {createDraft.attributes.map((attribute, index) => (
                <div className="attribute-row" key={`create-${attribute.id ?? "new"}-${index}`}>
                  <input
                    value={attribute.key}
                    onChange={(event) => updateAttribute("create", index, { key: event.target.value })}
                    placeholder="key"
                  />
                  <input
                    value={attribute.value ?? ""}
                    onChange={(event) => updateAttribute("create", index, { value: event.target.value })}
                    placeholder="value"
                  />
                  <button className="mini-button danger-button" type="button" onClick={() => removeAttribute("create", index)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="link-box">
              <div className="section-title-row">
                <h3>Optional link on create</h3>
                <span>One-step connect</span>
              </div>
              <label>
                <span>Existing person</span>
                <select
                  value={createLink.existing_person_id}
                  onChange={(event) =>
                    setCreateLink((current) => ({ ...current, existing_person_id: event.target.value }))
                  }
                >
                  <option value="">No link yet</option>
                  {graph.people.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Direction</span>
                <select
                  value={createLink.direction}
                  onChange={(event) =>
                    setCreateLink((current) => ({
                      ...current,
                      direction: event.target.value as "new_to_existing" | "existing_to_new"
                    }))
                  }
                >
                  <option value="new_to_existing">New person to existing person</option>
                  <option value="existing_to_new">Existing person to new person</option>
                </select>
              </label>
              <label>
                <span>Relation</span>
                <select
                  value={createLink.relation_choice}
                  onChange={(event) => handleCreateLinkChoiceChange(event.target.value)}
                >
                  <option value="">Select relation</option>
                  {RELATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  <option value={CUSTOM_RELATION_VALUE}>Custom...</option>
                </select>
              </label>
              {createLink.relation_choice === CUSTOM_RELATION_VALUE ? (
                <label>
                  <span>Custom relation</span>
                  <input
                    value={createLink.relation_type}
                    onChange={(event) =>
                      setCreateLink((current) => ({ ...current, relation_type: event.target.value }))
                    }
                    placeholder="family friend, introduced_by..."
                  />
                </label>
              ) : null}
            </div>

            <div className="action-row">
              <button disabled={busy} type="submit">
                Add person
              </button>
            </div>
          </form>
        </section>

        <section className="panel">
          <div className="section-title-row">
            <h2>Selected Person</h2>
            {selectedPerson ? <span>#{selectedPerson.id}</span> : <span>Nothing selected</span>}
          </div>
          {selectedPerson ? (
            <div className="stack">
              <label>
                <span>Name</span>
                <input
                  className={editNameError ? "field-error-input" : undefined}
                  value={editDraft.name}
                  onChange={(event) => {
                    setEditDraft((current) => ({ ...current, name: event.target.value }));
                    if (event.target.value.trim()) {
                      setEditNameError("");
                    }
                  }}
                />
                {editNameError ? <small className="field-error-text">{editNameError}</small> : null}
              </label>
              <label>
                <span>Category</span>
                <input
                  value={editDraft.category}
                  onChange={(event) => setEditDraft((current) => ({ ...current, category: event.target.value }))}
                />
              </label>
              <div className="meta-grid">
                <label>
                  <span>DOB</span>
                  <input
                    type="date"
                    value={editDraft.date_of_birth}
                    onChange={(event) => setEditDraft((current) => ({ ...current, date_of_birth: event.target.value }))}
                  />
                </label>
                <label>
                  <span>YOB</span>
                  <input
                    inputMode="numeric"
                    value={editDraft.birth_year}
                    onChange={(event) => setEditDraft((current) => ({ ...current, birth_year: event.target.value }))}
                    placeholder="1998"
                  />
                </label>
              </div>
              <div className="meta-grid">
                <label>
                  <span>Gender</span>
                  <select
                    value={editDraft.gender}
                    onChange={(event) => setEditDraft((current) => ({ ...current, gender: event.target.value }))}
                  >
                    <option value="">Unspecified</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label>
                  <span>Status</span>
                  <select
                    value={editDraft.is_alive}
                    onChange={(event) =>
                      setEditDraft((current) => ({
                        ...current,
                        is_alive: event.target.value as "alive" | "deceased" | "unknown"
                      }))
                    }
                  >
                    <option value="unknown">Unknown</option>
                    <option value="alive">Alive</option>
                    <option value="deceased">Deceased</option>
                  </select>
                </label>
              </div>
              <label>
                <span>Notes</span>
                <textarea
                  value={editDraft.notes}
                  onChange={(event) => setEditDraft((current) => ({ ...current, notes: event.target.value }))}
                  rows={3}
                />
              </label>
              <div className="attributes-block">
                <div className="section-title-row">
                  <h3>Attributes</h3>
                  <button className="mini-button" type="button" onClick={() => addAttributeField("edit")}>
                    Add field
                  </button>
                </div>
                {editDraft.attributes.map((attribute, index) => (
                  <div className="attribute-row" key={`edit-${attribute.id ?? "new"}-${index}`}>
                    <input
                      value={attribute.key}
                      onChange={(event) => updateAttribute("edit", index, { key: event.target.value })}
                      placeholder="key"
                    />
                    <input
                      value={attribute.value ?? ""}
                      onChange={(event) => updateAttribute("edit", index, { value: event.target.value })}
                      placeholder="value"
                    />
                    <button className="mini-button danger-button" type="button" onClick={() => removeAttribute("edit", index)}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="action-row">
                <button disabled={busy} type="button" onClick={handleUpdatePerson}>
                  Save edits
                </button>
                <button disabled={busy} type="button" className="danger-button" onClick={handleDeletePerson}>
                  Delete person
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">Select a node to edit a person without interrupting the add flow.</p>
          )}
        </section>

        <section className="panel">
          <div className="section-title-row">
            <h2>Suggestions</h2>
            <span>{suggestions.length} pending</span>
          </div>
          {suggestions.length === 0 ? (
            <p className="muted">
              {selectedPersonId
                ? "No pending suggestions for this person right now."
                : "No pending relationship suggestions right now."}
            </p>
          ) : (
            <div className="suggestion-list">
              {suggestions.map((suggestion) => (
                <div className="suggestion-card" key={suggestion.id}>
                  <strong>
                    {personName(graph.people, suggestion.from_person_id)} {suggestion.relation_type}{" "}
                    {personName(graph.people, suggestion.to_person_id)}
                  </strong>
                  <p>{suggestion.reason}</p>
                  {suggestion.suggestion_kind === "clarify" ? (
                    <label>
                      <span>Choose relation</span>
                      <select
                        value={suggestionChoices[suggestion.id] ?? suggestion.options[0] ?? ""}
                        onChange={(event) =>
                          setSuggestionChoices((current) => ({
                            ...current,
                            [suggestion.id]: event.target.value
                          }))
                        }
                      >
                        {suggestion.options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <div className="action-row">
                    <button disabled={busy} type="button" onClick={() => handleSuggestionDecision(suggestion, "accept")}>
                      Accept
                    </button>
                    <button
                      disabled={busy}
                      type="button"
                      className="ghost-button"
                      onClick={() => handleSuggestionDecision(suggestion, "decline")}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="section-title-row">
            <h2>{selectedRelationship ? "Edit Relationship" : "Add Relationship"}</h2>
            {selectedRelationship ? <span>#{selectedRelationship.id}</span> : <span>Graph edge</span>}
          </div>
          <form className="stack" onSubmit={handleCreateRelationship}>
            <label>
              <span>From</span>
              <select
                value={relationshipDraft.from_person_id}
                onChange={(event) =>
                  setRelationshipDraft((current) => ({ ...current, from_person_id: event.target.value }))
                }
              >
                <option value="">Select person</option>
                {graph.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>To</span>
              <select
                value={relationshipDraft.to_person_id}
                onChange={(event) =>
                  setRelationshipDraft((current) => ({ ...current, to_person_id: event.target.value }))
                }
              >
                <option value="">Select person</option>
                {graph.people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Relation</span>
              <select
                value={relationshipDraft.relation_choice}
                onChange={(event) => handleRelationshipChoiceChange(event.target.value)}
              >
                <option value="">Select relation</option>
                {RELATION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
                <option value={CUSTOM_RELATION_VALUE}>Custom...</option>
              </select>
            </label>
            {relationshipDraft.relation_choice === CUSTOM_RELATION_VALUE ? (
              <label>
                <span>Custom relation</span>
                <input
                  value={relationshipDraft.relation_type}
                  onChange={(event) =>
                    setRelationshipDraft((current) => ({ ...current, relation_type: event.target.value }))
                  }
                  placeholder="introduced_by, godparent..."
                />
              </label>
            ) : null}
            <div className="action-row">
              <button disabled={busy} type="submit">
                Add relation
              </button>
              <button disabled={busy || !selectedRelationship} type="button" onClick={handleUpdateRelationship}>
                Save edits
              </button>
              <button
                disabled={busy || !selectedRelationship}
                type="button"
                className="danger-button"
                onClick={handleDeleteRelationship}
              >
                Delete edge
              </button>
            </div>
          </form>
        </section>
      </aside>

      <main className="canvas-shell">
        <div className="canvas-header">
          <div>
            <p className="eyebrow">Live Graph</p>
            <h2>People and relationships</h2>
          </div>
          <div className="canvas-actions">
            <button className="ghost-button" type="button" onClick={handleResetLayout}>
              Reset layout
            </button>
            <p className="status-pill">{status}</p>
          </div>
        </div>
        <div className="graph-debug">
          <span>nodes {graphDebug.nodes}</span>
          <span>edges {graphDebug.edges}</span>
          <span>bounds {graphDebug.bounds.width} x {graphDebug.bounds.height}</span>
          <span>viewport z {graphDebug.viewport.zoom}</span>
          <span>init {graphDebug.initialized ? "yes" : "no"}</span>
        </div>
        <div className="graph-legend">
          <span className="legend-item"><span className="legend-swatch blood" /> Blood and lineage</span>
          <span className="legend-item"><span className="legend-swatch spouse" /> Spouse</span>
          <span className="legend-item"><span className="legend-swatch family-other" /> Extended family</span>
          <span className="legend-item"><span className="legend-swatch social" /> Social and work</span>
        </div>
        <div className="canvas-card">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeSelect}
            onEdgeClick={handleEdgeSelect}
            minZoom={0.18}
          >
            <MiniMap
              pannable
              zoomable
              bgColor="#0a1020"
              maskColor="rgba(8, 12, 24, 0.72)"
              nodeColor="#223657"
              nodeStrokeColor="#6ae2ff"
            />
            <Controls />
            <Background gap={24} size={1} color="#24324d" />
          </ReactFlow>
        </div>
      </main>
    </div>
  );
}


function buildNodes(
  people: Person[],
  selectedPersonId: number | null,
  relationships: Relationship[]
): Node[] {
  const positions = buildAutomaticPositions(people, relationships);

  return people.map((person, index) => {
    const position = positions.get(person.id) ?? fallbackPosition(index, people.length);

    return {
      id: String(person.id),
      type: "personNode",
      position,
      data: {
        label: (
          <div className="node-card">
            <div className="node-title-row">
              <strong>{person.name}</strong>
            </div>
            <div className="node-meta-row">
              {person.category ? <span className="node-badge">{person.category}</span> : null}
            </div>
            <div className="node-subline">
              {formatAge(person)}
              {formatBirthMeta(person) ? <span>{formatBirthMeta(person)}</span> : null}
            </div>
          </div>
        ),
        category: person.category
      },
      style: {
        borderRadius: 18,
        border: nodeBorder(person, person.id === selectedPersonId),
        background: nodeBackground(person),
        color: "#eff6ff",
        padding: 12,
        minWidth: 164,
        boxShadow:
          person.id === selectedPersonId
            ? "0 0 0 1px rgba(102,224,255,0.32), 0 18px 44px rgba(37, 153, 255, 0.25)"
            : "0 14px 30px rgba(0, 0, 0, 0.35)"
      }
    } satisfies Node;
  });
}

function buildAutomaticPositions(
  people: Person[],
  relationships: Relationship[]
): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>();
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const adjacency = new Map<number, Set<number>>();

  people.forEach((person) => {
    adjacency.set(person.id, new Set<number>());
  });

  relationships.forEach((relationship) => {
    linkPeople(adjacency, relationship.from_person_id, relationship.to_person_id);
  });

  const visited = new Set<number>();
  const components: number[][] = [];
  people.forEach((person) => {
    if (visited.has(person.id)) {
      return;
    }
    components.push(collectComponent(person.id, adjacency, visited));
  });

  let cursorX = 0;
  let cursorY = 0;
  let currentRowHeight = 0;
  const wrapWidth = 2200;
  const componentGapX = 280;
  const componentGapY = 260;

  components
    .sort((left, right) => right.length - left.length)
    .forEach((componentIds, componentIndex) => {
      const componentPeople = componentIds
        .map((id) => peopleById.get(id))
        .filter((person): person is Person => Boolean(person));
      const componentRelationships = relationships.filter(
        (relationship) =>
          componentIds.includes(relationship.from_person_id) && componentIds.includes(relationship.to_person_id)
      );

      const localPositions = componentRelationships.some((relationship) => isFamilyRelation(relationship.relation_type))
        ? buildFamilyPositions(componentPeople, componentRelationships)
        : buildSocialClusterPositions(componentPeople);
      const bounds = getPositionBounds(localPositions);

      if (componentIndex > 0 && cursorX + bounds.width > wrapWidth) {
        cursorX = 0;
        cursorY += currentRowHeight + componentGapY;
        currentRowHeight = 0;
      }

      componentPeople.forEach((person, index) => {
        const localPosition = localPositions.get(person.id) ?? fallbackPosition(index, componentPeople.length);
        positions.set(person.id, {
          x: cursorX + (localPosition.x - bounds.minX),
          y: cursorY + (localPosition.y - bounds.minY)
        });
      });

      cursorX += bounds.width + componentGapX;
      currentRowHeight = Math.max(currentRowHeight, bounds.height);
    });

  return positions;
}

function buildFamilyPositions(
  people: Person[],
  relationships: Relationship[]
): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>();
  const familyRelationships = relationships.filter((relationship) => isFamilyRelation(relationship.relation_type));
  const familyIds = new Set<number>();

  familyRelationships.forEach((relationship) => {
    familyIds.add(relationship.from_person_id);
    familyIds.add(relationship.to_person_id);
  });

  const familyPeople = people.filter((person) => familyIds.has(person.id));
  const levels = inferGenerationLevels(familyPeople, familyRelationships);
  const groupedByLevel = new Map<number, number[]>();
  const rowGap = 200;
  const colGap = 240;

  familyPeople.forEach((person) => {
    const level = levels.get(person.id) ?? 0;
    const bucket = groupedByLevel.get(level) ?? [];
    bucket.push(person.id);
    groupedByLevel.set(level, bucket);
  });

  [...groupedByLevel.keys()]
    .sort((left, right) => left - right)
    .forEach((level) => {
      const ids = (groupedByLevel.get(level) ?? [])
        .slice()
        .sort((left, right) => compareFamilyRowOrder(left, right, relationships, levels));
      const rowWidth = Math.max(ids.length - 1, 0) * colGap;
      ids.forEach((personId, index) => {
        positions.set(personId, {
          x: index * colGap - rowWidth / 2,
          y: level * rowGap
        });
      });
    });

  const unplaced = people
    .filter((person) => !positions.has(person.id))
    .sort((left, right) => left.id - right.id);
  if (unplaced.length > 0) {
    const familyLevels = [...groupedByLevel.keys()];
    const baseY = familyLevels.length === 0 ? 0 : Math.max(...familyLevels) * rowGap + Math.round(rowGap * 1.2);
    const rowWidth = Math.max(unplaced.length - 1, 0) * colGap;
    unplaced.forEach((person, index) => {
      positions.set(person.id, {
        x: index * colGap - rowWidth / 2,
        y: baseY
      });
    });
  }

  return positions;
}

function buildSocialClusterPositions(people: Person[]): Map<number, { x: number; y: number }> {
  const positions = new Map<number, { x: number; y: number }>();
  const sortedPeople = people.slice().sort((left, right) => left.id - right.id);
  const columnCount = sortedPeople.length <= 3 ? sortedPeople.length : Math.ceil(Math.sqrt(sortedPeople.length));
  const cellWidth = 220;
  const cellHeight = 170;

  sortedPeople.forEach((person, index) => {
    const row = Math.floor(index / Math.max(columnCount, 1));
    const column = index % Math.max(columnCount, 1);
    positions.set(person.id, {
      x: column * cellWidth,
      y: row * cellHeight
    });
  });

  return positions;
}

function getPositionBounds(positions: Map<number, { x: number; y: number }>): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  const values = [...positions.values()];
  if (values.length === 0) {
    return { minX: 0, minY: 0, width: 220, height: 160 };
  }

  const minX = Math.min(...values.map((position) => position.x));
  const minY = Math.min(...values.map((position) => position.y));
  const maxX = Math.max(...values.map((position) => position.x));
  const maxY = Math.max(...values.map((position) => position.y));

  return {
    minX,
    minY,
    width: Math.max(maxX - minX + 220, 220),
    height: Math.max(maxY - minY + 160, 160)
  };
}

function inferGenerationLevels(
  people: Person[],
  relationships: Relationship[]
): Map<number, number> {
  const levels = new Map<number, number>();
  const familyIds = new Set<number>(people.map((person) => person.id));
  const parentsByChild = new Map<number, number[]>();
  const childrenByParent = new Map<number, number[]>();
  const familyAdjacency = new Map<number, Set<number>>();
  const siblingPairs: Array<[number, number]> = [];
  const spousePairs: Array<[number, number]> = [];

  relationships.forEach((relationship) => {
    const parentEdge = canonicalParentEdge(relationship);
    if (parentEdge) {
      const parents = parentsByChild.get(parentEdge.childId) ?? [];
      parents.push(parentEdge.parentId);
      parentsByChild.set(parentEdge.childId, parents);
      const children = childrenByParent.get(parentEdge.parentId) ?? [];
      children.push(parentEdge.childId);
      childrenByParent.set(parentEdge.parentId, children);
      linkPeople(familyAdjacency, parentEdge.parentId, parentEdge.childId);
      return;
    }

    const relation = normalizeRelation(relationship.relation_type);
    if (["brother", "sister", "sibling"].includes(relation)) {
      siblingPairs.push([relationship.from_person_id, relationship.to_person_id]);
    }
    if (relation === "spouse") {
      spousePairs.push([relationship.from_person_id, relationship.to_person_id]);
    }
    if (isFamilyRelation(relation)) {
      linkPeople(familyAdjacency, relationship.from_person_id, relationship.to_person_id);
    }
  });

  const depthMemo = new Map<number, number>();
  const visiting = new Set<number>();

  function depthFor(personId: number): number {
    const cached = depthMemo.get(personId);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(personId)) {
      return 0;
    }

    visiting.add(personId);
    const parents = parentsByChild.get(personId) ?? [];
    const depth = parents.length === 0 ? 0 : Math.max(...parents.map((parentId) => depthFor(parentId) + 1));
    visiting.delete(personId);
    depthMemo.set(personId, depth);
    return depth;
  }

  familyIds.forEach((personId) => {
    const hasParentStructure = parentsByChild.has(personId) || (childrenByParent.get(personId)?.length ?? 0) > 0;
    if (hasParentStructure) {
      levels.set(personId, depthFor(personId));
    }
  });

  for (let pass = 0; pass < 8; pass += 1) {
    siblingPairs.forEach(([left, right]) => alignGeneration(levels, left, right));
    spousePairs.forEach(([left, right]) => alignGeneration(levels, left, right));
    childrenByParent.forEach((children, parentId) => {
      const parentLevel = levels.get(parentId);
      if (parentLevel === undefined) {
        return;
      }
      children.forEach((childId) => {
        const nextLevel = parentLevel + 1;
        const currentLevel = levels.get(childId);
        if (currentLevel === undefined || currentLevel < nextLevel) {
          levels.set(childId, nextLevel);
        }
      });
    });
  }

  const visited = new Set<number>();
  familyIds.forEach((personId) => {
    if (visited.has(personId)) {
      return;
    }
    const component = collectComponent(personId, familyAdjacency, visited);
    const assignedLevels = component
      .map((id) => levels.get(id))
      .filter((value): value is number => value !== undefined);
    if (assignedLevels.length === 0) {
      component.forEach((id) => levels.set(id, 0));
      return;
    }
    const baseline = Math.min(...assignedLevels);
    component.forEach((id) => {
      const currentLevel = levels.get(id);
      levels.set(id, currentLevel === undefined ? 0 : currentLevel - baseline);
    });
  });

  return levels;
}

function alignGeneration(levels: Map<number, number>, left: number, right: number): void {
  const leftLevel = levels.get(left);
  const rightLevel = levels.get(right);

  if (leftLevel !== undefined && rightLevel === undefined) {
    levels.set(right, leftLevel);
    return;
  }
  if (rightLevel !== undefined && leftLevel === undefined) {
    levels.set(left, rightLevel);
    return;
  }
  if (leftLevel !== undefined && rightLevel !== undefined) {
    const alignedLevel = Math.max(leftLevel, rightLevel);
    levels.set(left, alignedLevel);
    levels.set(right, alignedLevel);
  }
}

function compareFamilyRowOrder(
  leftId: number,
  rightId: number,
  relationships: Relationship[],
  levels: Map<number, number>
): number {
  const leftScore = familyRowScore(leftId, relationships, levels);
  const rightScore = familyRowScore(rightId, relationships, levels);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return leftId - rightId;
}

function familyRowScore(
  personId: number,
  relationships: Relationship[],
  levels: Map<number, number>
): number {
  const linkedPeers = relationships
    .filter((relationship) => {
      const relation = normalizeRelation(relationship.relation_type);
      return ["brother", "sister", "sibling", "spouse"].includes(relation)
        && (relationship.from_person_id === personId || relationship.to_person_id === personId);
    })
    .map((relationship) => (relationship.from_person_id === personId ? relationship.to_person_id : relationship.from_person_id));

  if (linkedPeers.length === 0) {
    return personId;
  }

  const peerLevelAverage = linkedPeers.reduce((total, peerId) => total + (levels.get(peerId) ?? 0), 0) / linkedPeers.length;
  return peerLevelAverage * 1000 + personId;
}

function linkPeople(adjacency: Map<number, Set<number>>, left: number, right: number): void {
  const leftSet = adjacency.get(left) ?? new Set<number>();
  leftSet.add(right);
  adjacency.set(left, leftSet);
  const rightSet = adjacency.get(right) ?? new Set<number>();
  rightSet.add(left);
  adjacency.set(right, rightSet);
}

function collectComponent(
  startId: number,
  adjacency: Map<number, Set<number>>,
  visited: Set<number>
): number[] {
  const component: number[] = [];
  const queue = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    component.push(current);
    (adjacency.get(current) ?? new Set<number>()).forEach((next) => {
      if (visited.has(next)) {
        return;
      }
      visited.add(next);
      queue.push(next);
    });
  }

  return component;
}

function canonicalParentEdge(
  relationship: Relationship
): { parentId: number; childId: number } | null {
  const relation = normalizeRelation(relationship.relation_type);
  if (["mother", "father", "parent", "stepfather", "stepmother", "guardian"].includes(relation)) {
    return {
      parentId: relationship.from_person_id,
      childId: relationship.to_person_id
    };
  }
  if (["son", "daughter", "child"].includes(relation)) {
    return {
      parentId: relationship.to_person_id,
      childId: relationship.from_person_id
    };
  }
  return null;
}


function fallbackPosition(index: number, totalCount: number): { x: number; y: number } {
  const total = Math.max(totalCount, 1);
  const angle = (index / total) * Math.PI * 2;
  const radius = total === 1 ? 0 : 220 + Math.floor(index / 6) * 110;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius
  };
}

function edgeHandlesForRelation(
  relationship: Relationship,
  positionsById: Map<string, { x: number; y: number }>
): { sourceHandle: string; targetHandle: string } {
  const relation = normalizeRelation(relationship.relation_type);
  const source = positionsById.get(String(relationship.from_person_id));
  const target = positionsById.get(String(relationship.to_person_id));

  if (["brother", "sister", "sibling", "spouse"].includes(relation) && source && target) {
    return source.x <= target.x
      ? { sourceHandle: "right-source", targetHandle: "left-target" }
      : { sourceHandle: "left-source", targetHandle: "right-target" };
  }

  const parentEdge = canonicalParentEdge(relationship);
  if (parentEdge) {
    if (parentEdge.parentId === relationship.from_person_id) {
      return { sourceHandle: "bottom-source", targetHandle: "top-target" };
    }
    return { sourceHandle: "top-source", targetHandle: "bottom-target" };
  }

  if (source && target) {
    const horizontalDistance = Math.abs(source.x - target.x);
    const verticalDistance = Math.abs(source.y - target.y);
    if (horizontalDistance >= verticalDistance) {
      return source.x <= target.x
        ? { sourceHandle: "right-source", targetHandle: "left-target" }
        : { sourceHandle: "left-source", targetHandle: "right-target" };
    }
  }

  return { sourceHandle: "bottom-source", targetHandle: "top-target" };
}

function buildEdges(
  relationships: Relationship[],
  selectedRelationshipId: number | null,
  nodes: Node[]
): Edge[] {
  const positionsById = new Map(
    nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }])
  );

  return relationships.map((relationship) => {
    const visualGroup = relationVisualGroup(relationship.relation_type);
    const edgeColor =
      visualGroup === "blood"
        ? "#ff8f6b"
        : visualGroup === "spouse"
          ? "#ffd166"
          : visualGroup === "family-other"
            ? "#8ee6c4"
            : "#6aa9ff";
    const strokeWidth =
      visualGroup === "blood"
        ? 3
        : visualGroup === "spouse"
          ? 2.6
          : visualGroup === "family-other"
            ? 2.2
            : 1.8;

    return {
      id: String(relationship.id),
      source: String(relationship.from_person_id),
      target: String(relationship.to_person_id),
      ...edgeHandlesForRelation(relationship, positionsById),
      label: relationship.relation_type,
      type: "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed
      },
      style: {
        stroke: relationship.id === selectedRelationshipId ? "#66e0ff" : edgeColor,
        strokeWidth: relationship.id === selectedRelationshipId ? strokeWidth + 0.8 : strokeWidth,
        strokeDasharray: visualGroup === "social" ? "6 6" : visualGroup === "family-other" ? "10 6" : undefined
      },
      labelBgPadding: [10, 6],
      labelBgBorderRadius: 10,
      labelBgStyle: {
        fill: "#0d1526",
        stroke: visualGroup === "blood" ? "#8d4d40" : visualGroup === "spouse" ? "#8e7440" : "#41506f",
        strokeWidth: 1,
        fillOpacity: 0.96
      },
      labelStyle: {
        fill: relationship.id === selectedRelationshipId ? "#66e0ff" : edgeColor,
        fontWeight: 600
      }
    };
  });
}


function cleanPersonDraft(draft: PersonDraft): PersonDraft {
  return {
    name: draft.name.trim(),
    notes: draft.notes.trim(),
    category: draft.category.trim(),
    date_of_birth: draft.date_of_birth.trim(),
    birth_year: draft.birth_year.trim(),
    gender: draft.gender.trim(),
    is_alive: draft.is_alive,
    attributes: draft.attributes
      .map((attribute) => ({
        key: attribute.key.trim(),
        value: attribute.value?.trim() || null
      }))
      .filter((attribute) => attribute.key.length > 0)
  };
}


function formatAge(person: Person): string {
  const now = new Date();
  if (person.date_of_birth) {
    const dob = new Date(person.date_of_birth);
    if (!Number.isNaN(dob.getTime())) {
      let age = now.getFullYear() - dob.getFullYear();
      const hasBirthdayPassed =
        now.getMonth() > dob.getMonth() ||
        (now.getMonth() === dob.getMonth() && now.getDate() >= dob.getDate());
      if (!hasBirthdayPassed) {
        age -= 1;
      }
      if (age >= 0) {
        return `${age}y`;
      }
    }
  }
  if (person.birth_year) {
    const age = now.getFullYear() - person.birth_year;
    if (age >= 0) {
      return `~${age}y`;
    }
  }
  return "age unknown";
}


function formatBirthMeta(person: Person): string {
  if (person.date_of_birth) {
    return person.date_of_birth;
  }
  if (person.birth_year) {
    return `YOB ${person.birth_year}`;
  }
  return "";
}


function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Something went wrong.";
}


function personName(people: Person[], personId: number): string {
  return people.find((person) => person.id === personId)?.name ?? `Person ${personId}`;
}

function formatGenderLabel(gender: string): string {
  const normalized = gender.trim().toLowerCase();
  if (!normalized) {
    return "Unspecified gender";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}


function nodeBorder(person: Person, isSelected: boolean): string {
  if (isSelected) {
    return "2px solid #66e0ff";
  }
  const gender = (person.gender ?? "").trim().toLowerCase();
  if (gender === "female") {
    return "1px solid rgba(255, 120, 184, 0.65)";
  }
  if (gender === "male") {
    return "1px solid rgba(98, 176, 255, 0.65)";
  }
  if (gender === "other") {
    return "1px solid rgba(106, 226, 255, 0.5)";
  }
  return "1px solid #43516d";
}


function nodeBackground(person: Person): string {
  const isAlive = person.is_alive;
  const gender = (person.gender ?? "").trim().toLowerCase();

  const accent =
    gender === "female"
      ? "rgba(255, 109, 177, 0.22)"
      : gender === "male"
        ? "rgba(64, 151, 255, 0.22)"
        : "rgba(106, 226, 255, 0.18)";

  const lifeGlow =
    isAlive === false
      ? "rgba(255, 196, 196, 0.08)"
      : isAlive === true
        ? "rgba(61, 216, 155, 0.12)"
        : "rgba(255, 255, 255, 0.04)";

  const deepBase = person.category ? "#18253d" : "#111a2c";
  const midBase = person.category ? "#24385f" : "#19243a";
  const deceasedPattern =
    isAlive === false
      ? ", repeating-linear-gradient(135deg, rgba(255,255,255,0.12) 0 2px, rgba(255,255,255,0.02) 2px 8px)"
      : "";

  return `${isAlive === false ? "repeating-linear-gradient(135deg, rgba(255,255,255,0.12) 0 2px, rgba(255,255,255,0.02) 2px 8px), " : ""}radial-gradient(circle at 88% 16%, ${accent}, transparent 28%), radial-gradient(circle at 14% 100%, ${lifeGlow}, transparent 34%), linear-gradient(135deg, ${deepBase} 0%, ${midBase} 100%)`;
}


function roundForLog(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}


export default App;
