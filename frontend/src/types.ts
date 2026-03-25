export type Attribute = {
  id?: number;
  key: string;
  value: string | null;
};

export type Person = {
  id: number;
  name: string;
  notes: string | null;
  category: string | null;
  date_of_birth: string | null;
  birth_year: number | null;
  gender: string | null;
  is_alive: boolean | null;
  created_at: string;
  updated_at: string;
  attributes: Attribute[];
};

export type Relationship = {
  id: number;
  from_person_id: number;
  to_person_id: number;
  relation_type: string;
  created_at: string;
  updated_at: string;
};

export type GraphResponse = {
  people: Person[];
  relationships: Relationship[];
};

export type RelationshipSuggestion = {
  id: number;
  from_person_id: number;
  to_person_id: number;
  relation_type: string;
  suggestion_kind: string;
  options: string[];
  rule_key: string;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
};

export type PersonDraft = {
  name: string;
  notes: string;
  category: string;
  date_of_birth: string;
  birth_year: string;
  gender: string;
  is_alive: "alive" | "deceased" | "unknown";
  attributes: Attribute[];
};

export type RelationshipDraft = {
  from_person_id: string;
  to_person_id: string;
  relation_choice: string;
  relation_type: string;
};
