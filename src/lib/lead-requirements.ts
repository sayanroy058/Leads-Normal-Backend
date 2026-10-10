// Flexible per-lead requirements — an ordered list of free-form label/value
// pairs (e.g. { label: "Property", value: "2 BHK Flat" }, { label: "Budget",
// value: "₹60L" }, { label: "Handover", value: "Within 6 months" }).
//
// The list is intentionally industry-neutral: nothing is hard-coded, so a real
// estate lead and a SaaS lead use the same field. It is stored in the
// leads.requirements column as a JSON array string so both the dashboard and
// the AI calling agent (via its future MCP tool) can add or update individual
// requirements without a schema change.

export interface LeadRequirement {
  label: string;
  value: string;
}

/** Coerce an arbitrary value (parsed array or JSON string) into a clean list. */
export function parseRequirements(raw: unknown): LeadRequirement[] {
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      return sanitize(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return sanitize(raw);
}

function sanitize(input: unknown): LeadRequirement[] {
  if (!Array.isArray(input)) return [];
  const out: LeadRequirement[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const label = String((item as Record<string, unknown>).label ?? "").trim();
    const value = String((item as Record<string, unknown>).value ?? "").trim();
    // Keep a row if either side is filled — label-only ("Owns a car") and
    // value-only rows are both meaningful.
    if (!label && !value) continue;
    out.push({ label, value });
  }
  return out;
}

/** Serialize a requirements list for storage. Empty list → null (no row). */
export function serializeRequirements(raw: unknown): string | null {
  const clean = parseRequirements(raw);
  return clean.length ? JSON.stringify(clean) : null;
}

/** One-line, human-readable rendering — used in AI briefs and context blocks. */
export function formatRequirements(raw: unknown): string {
  return parseRequirements(raw)
    .map((r) => (r.label ? `${r.label}: ${r.value}` : r.value))
    .join("; ");
}

/** Replace a lead row's stored JSON string with a parsed array for API output. */
export function normalizeLeadRequirements<T extends Record<string, unknown>>(row: T): T & { requirements: LeadRequirement[] } {
  return { ...row, requirements: parseRequirements(row.requirements) };
}
