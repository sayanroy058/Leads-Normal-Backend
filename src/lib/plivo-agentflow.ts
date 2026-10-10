// Plivo Agentflow — the AI voice agent that places outbound calls.
//
// The Agentflow "API Request" trigger is a plain HTTP endpoint:
//   POST https://agentflow.plivo.com/v1/account/{AUTH_ID}/flow/{FLOW_UUID}
// The URL *is* the credential — there is no auth header — so it lives in
// PLIVO_AGENTFLOW_URL and must never be committed.
//
// On success it returns: { api_id, phlo_id, message: "Phlo run queued" }.
// `phlo_id` is the flow-run id we store on the call log and correlate with the
// "Event Callbacks" the flow posts back to our webhook.
//
// PAYLOAD KEYS: the flow decides which keys exist — they are the variables
// configured on the flow's trigger node. Unknown keys are ignored by Plivo, so
// we send a superset of the common names to bind to whichever the flow uses.
// Once the flow's variable names are confirmed, trim this to exactly those.
import { formatRequirements } from "./lead-requirements";

/** Trim a lead's free-text so a very long note can't blow past the flow's prompt limit. */
function brief(value: string | null | undefined, max = 400): string {
  const s = (value ?? "").trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Normalise a stored phone number to strict E.164 — Plivo rejects anything
 * else. Leads are commonly saved as "+91 70146 07737" or "(555) 010-1234",
 * which the telco network will not accept, so strip the human formatting and
 * keep only a leading `+` plus digits.
 *
 * Returns null when the result isn't a plausible international number, so the
 * caller can show a useful error instead of letting Plivo fail opaquely.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Drop any extension before stripping punctuation — otherwise "… ext 5"
  // would silently dial a different, wrong number.
  const base = trimmed.replace(/\s*(?:ext|ext\.|x|extension|#)\s*\d+\s*$/i, "").trim();
  // Keep a leading '+' only; drop spaces, dashes, dots, parens and unicode dashes.
  const plus = base.startsWith("+") ? "+" : "";
  const digits = base.replace(/\D/g, "");
  if (!digits) return null;
  const e164 = `${plus}${digits}`;
  // E.164: country code + subscriber, 8–15 digits total.
  if (digits.length < 8 || digits.length > 15) return null;
  return e164;
}

/**
 * Build the brief the AI agent speaks from: who this person is and what they
 * asked for. This is the whole point of the feature — the agent talks to the
 * lead about *their own recorded requirements*, not a generic script.
 *
 * Used in both directions: for an outbound call the agent places (default), and
 * for an inbound call the agent answers (`{ inbound: true }` — see
 * routes/external.ts `/leads/lookup`), where "you are calling" would be wrong.
 */
export function buildAgentBrief(lead: {
  name: string; company: string | null; city: string | null; phone: string | null;
  notes: string | null; interest: string | null; category: string | null;
  budget_min: number | null; budget_max: number | null; region: string | null;
  urgency: string | null; value: number | null; status: string; score: number;
  requirements?: unknown;
}, goal?: string | null, opts: { inbound?: boolean } = {}): string {
  const budget =
    lead.budget_min != null && lead.budget_max != null
      ? `${lead.budget_min}–${lead.budget_max}`
      : lead.budget_max != null
        ? `up to ${lead.budget_max}`
        : lead.budget_min != null
          ? `from ${lead.budget_min}`
          : null;

  const requirements = formatRequirements(lead.requirements);

  const facts = [
    `Lead name: ${lead.name}`,
    lead.company ? `Company: ${lead.company}` : null,
    lead.city ? `Location: ${lead.city}` : null,
    lead.region ? `Region: ${lead.region}` : null,
    lead.interest ? `Requirement / interest: ${lead.interest}` : null,
    lead.category ? `Category: ${lead.category}` : null,
    requirements ? `Recorded requirements: ${requirements}` : null,
    budget ? `Budget: ${budget}` : null,
    lead.urgency ? `Urgency: ${lead.urgency}` : null,
    lead.value != null ? `Deal value: ${lead.value}` : null,
    `Pipeline status: ${lead.status}`,
    goal ? `Call goal: ${goal}` : null,
    lead.notes ? `Notes: ${brief(lead.notes, 800)}` : null,
  ].filter(Boolean) as string[];

  const intro = opts.inbound
    ? "You are answering an inbound call on behalf of GradLeadAI from the person below. Use ONLY the details below when speaking to them."
    : "You are calling a sales lead on behalf of GradLeadAI. Use ONLY the details below when speaking to them.";

  const guidance = opts.inbound
    ? "Greet the caller and say who you are, then answer their questions from these details. They may be an existing contact or a first-time enquiry — if they ask for something new, capture it. If something is not in these details, say so and offer to follow up — do not invent facts, prices, or dates."
    : "Open by identifying yourself and referring to their stated requirement. Confirm the details, answer their questions, and aim to move them to the next step. If something is not in these details, say so and offer to follow up — do not invent facts, prices, or dates.";

  return [intro, "", ...facts, "", guidance].join("\n");
}

export interface DialResult {
  phlo_id: string | null;
  api_id: string | null;
  message: string | null;
}

/** Fire the Agentflow trigger. Throws with a useful message on failure. */
export async function triggerAgentflow(payload: Record<string, unknown>): Promise<DialResult> {
  const url = process.env.PLIVO_AGENTFLOW_URL?.trim();
  if (!url) {
    throw new Error("AI voice agent is not configured — set PLIVO_AGENTFLOW_URL in the environment.");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Voice agent rejected the request (${res.status}): ${text.slice(0, 300)}`);
  }
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON body — keep data empty */ }
  return {
    phlo_id: (data.phlo_id as string) ?? null,
    api_id: (data.api_id as string) ?? null,
    message: (data.message as string) ?? null,
  };
}

/**
 * Build the trigger payload for a lead. Superset of plausible variable names —
 * see the PAYLOAD KEYS note at the top of this file.
 */
export function buildTriggerPayload(args: {
  leadId: string; callId: string; toNumber: string; leadName: string; brief: string;
  company: string | null; interest: string | null; goal?: string | null;
}): Record<string, unknown> {
  const { leadId, callId, toNumber, leadName, brief, company, interest, goal } = args;
  return {
    // Destination — matches whichever name the flow's Screen Contact node uses.
    to: toNumber, to_number: toNumber, phone: toNumber, phone_number: toNumber,
    destination: toNumber, destination_number: toNumber, number: toNumber, lead_phone: toNumber,
    // Who we're calling.
    name: leadName, lead_name: leadName, contact_name: leadName, first_name: leadName.split(" ")[0],
    company,
    // What the agent should talk about.
    prompt: brief, context: brief, requirements: brief, details: brief, brief,
    system_prompt: brief, instructions: brief, notes: brief, message: brief, description: brief,
    lead_context: brief, conversation_brief: brief, summary: brief,
    // Goal + correlation ids so the flow can branch and we can match callbacks.
    goal: goal ?? null, call_goal: goal ?? null, objective: goal ?? null,
    interest, requirement: interest,
    // Correlation. `call_id` must be OUR call-log id, not the lead id, so a
    // callback matches exactly one row. Plivo's own phlo_id is flow-level and
    // identical for every run, so it cannot identify a single call.
    call_id: callId, reference_id: callId, call_uuid: callId, call_ref: callId,
    lead_id: leadId,
  };
}