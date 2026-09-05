import { Hono } from "hono";
import { z } from "zod";
import type { InStatement } from "@libsql/client";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

router.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (
    await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE user_id = ? ORDER BY created_at DESC", args: [user.id] })
  ).rows;
  return c.json(rows);
});

// Generic pipeline stages.
export const LEAD_STATUSES = ["new", "contacted", "qualified", "meeting", "proposal", "closed", "lost"] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

const leadSchema = z.object({
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  score: z.number().optional(),
  value: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Lead detail fields
  interest: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  budget_min: z.number().nullable().optional(),
  budget_max: z.number().nullable().optional(),
  region: z.string().nullable().optional(),
  urgency: z.string().nullable().optional(),
});

const updateLeadSchema = z.object({
  name: z.string().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  score: z.number().optional(),
  value: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  // Lead detail fields
  interest: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  budget_min: z.number().nullable().optional(),
  budget_max: z.number().nullable().optional(),
  region: z.string().nullable().optional(),
  urgency: z.string().nullable().optional(),
});

const SCORE_FIELDS = [
  "email", "phone", "company", "city", "notes", "value",
  "interest", "category", "region", "urgency",
] as const;

// Score 0-100 based on how many lead fields are filled vs. missing.
export function computeLeadScore(r: Record<string, unknown>): number {
  let present = 0;
  for (const f of SCORE_FIELDS) {
    const v = r[f];
    if (v !== undefined && v !== null && String(v).trim() !== "") present++;
  }
  return Math.round((present / SCORE_FIELDS.length) * 100);
}

router.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted: Record<string, unknown>[] = [];
  const statements: InStatement[] = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    statements.push({
      sql: "INSERT OR REPLACE INTO leads (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at, interest, category, budget_min, budget_max, region, urgency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, user.id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", computeLeadScore(r), r.value ?? null, r.city ?? null, r.notes ?? null, now, now, r.interest ?? null, r.category ?? null, r.budget_min ?? null, r.budget_max ?? null, r.region ?? null, r.urgency ?? null],
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: computeLeadScore(r), last_activity: now, created_at: now });
  }
  if (statements.length) await db.batch(statements, "write"); // atomic import
  return c.json(inserted);
});

router.post("/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z.object({ id: z.string(), status: z.enum(LEAD_STATUSES) }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "UPDATE leads SET status = ?, last_activity = ? WHERE id = ? AND user_id = ?",
    args: [status, new Date().toISOString(), id, user.id],
  });
  return c.json({ success: true });
});

router.get("/activity/counts", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (
    await (await getDb()).execute({
      sql: `SELECT
      (SELECT COUNT(*) FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS emails,
      (SELECT COUNT(*) FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS whatsapps,
      (SELECT COUNT(*) FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS calls,
      (SELECT COUNT(*) FROM appointments m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS appts`,
      args: [user.id, user.id, user.id, user.id],
    })
  ).rows;
  const row = rows[0] as unknown as { emails: number; whatsapps: number; calls: number; appts: number };
  return c.json({ emails: row.emails, whatsapps: row.whatsapps, calls: row.calls, appts: row.appts });
});

router.get("/activity/feed", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const rows = (await db.execute({
    sql: `SELECT e.id, e.type, e.channel, e.direction, e.action, e.summary, e.content, e.created_at
          FROM events e JOIN leads l ON l.id = e.lead_id
          WHERE e.channel IN ('email','whatsapp','call') AND l.user_id = ?
          ORDER BY e.created_at DESC LIMIT 20`,
    args: [user.id],
  })).rows as unknown as {
    id: string;
    type: string | null;
    channel: string;
    direction: string | null;
    action: string;
    summary: string | null;
    content: string | null;
    created_at: string;
  }[];
  const items = rows.map((e) => {
    const dir = e.direction === "inbound" ? "inbound" : "outbound";
    const body = e.content ?? e.summary ?? "";
    return {
      id: e.id,
      type: e.type ?? e.channel,
      text:
        e.channel === "email"
          ? `${dir === "inbound" ? "Inbound" : "Sent"} email — ${e.action}: "${e.summary ?? ""}"`
          : e.channel === "whatsapp"
            ? `${dir === "inbound" ? "Inbound WhatsApp" : "Outbound WhatsApp"} — ${body.slice(0, 80)}`
            : `Call — ${e.action}${e.summary ? `: ${e.summary}` : ""}`,
      when: e.created_at,
    };
  });
  return c.json(items.slice(0, 8));
});

router.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const row = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [c.req.param("id"), user.id] })).rows[0];
  if (!row) return c.json({ error: "Lead not found" }, 404);
  return c.json(row);
});

router.put("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const data = updateLeadSchema.parse(await c.req.json());
  const db = await getDb();
  const existing = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] })).rows[0] as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: "Lead not found" }, 404);
  const score = computeLeadScore({ ...existing, ...data });
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "score") continue; // score is auto-computed from field completeness
    sets.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  sets.push("score = ?");
  vals.push(score);
  sets.push("last_activity = ?");
  vals.push(new Date().toISOString());
  vals.push(id, user.id);
  await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  return c.json(row);
});

router.delete("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  await (await getDb()).execute({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] });
  return c.json({ success: true });
});

router.post("/bulk-delete", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(await c.req.json());
  const db = await getDb();
  const statements: InStatement[] = ids.map((id) => ({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] }));
  await db.batch(statements, "write"); // atomic bulk delete
  return c.json({ success: true, deleted: ids.length });
});

export default router;
