export type RelationOption = {
  label: string;
  value: string;
};


export const RELATION_OPTIONS: RelationOption[] = [
  { label: "Mother", value: "mother" },
  { label: "Father", value: "father" },
  { label: "Brother", value: "brother" },
  { label: "Sister", value: "sister" },
  { label: "Sibling", value: "sibling" },
  { label: "Son", value: "son" },
  { label: "Daughter", value: "daughter" },
  { label: "Parent", value: "parent" },
  { label: "Child", value: "child" },
  { label: "Spouse", value: "spouse" },
  { label: "Stepfather", value: "stepfather" },
  { label: "Stepmother", value: "stepmother" },
  { label: "Friend", value: "friend" },
  { label: "Colleague", value: "colleague" },
  { label: "Classmate", value: "classmate" },
  { label: "Neighbor", value: "neighbor" },
  { label: "Guardian", value: "guardian" },
  { label: "Mentor", value: "mentor" },
  { label: "Relative", value: "relative" },
];


export const CUSTOM_RELATION_VALUE = "__custom__";


export function isKnownRelation(value: string): boolean {
  return RELATION_OPTIONS.some((option) => option.value === value);
}


export function normalizeRelation(value: string): string {
  return value.trim().toLowerCase();
}


export function isBloodRelation(value: string): boolean {
  const relation = normalizeRelation(value);
  return [
    "mother",
    "father",
    "parent",
    "son",
    "daughter",
    "child",
    "brother",
    "sister",
    "sibling"
  ].includes(relation);
}


export function isSpouseRelation(value: string): boolean {
  return normalizeRelation(value) === "spouse";
}


export function isFamilyRelation(value: string): boolean {
  const relation = normalizeRelation(value);
  return isBloodRelation(relation) || isSpouseRelation(relation) || ["stepfather", "stepmother", "guardian", "relative"].includes(relation);
}


export function relationVisualGroup(value: string): "blood" | "spouse" | "family-other" | "social" {
  const relation = normalizeRelation(value);
  if (isBloodRelation(relation)) {
    return "blood";
  }
  if (isSpouseRelation(relation)) {
    return "spouse";
  }
  if (["stepfather", "stepmother", "guardian", "relative"].includes(relation)) {
    return "family-other";
  }
  return "social";
}
