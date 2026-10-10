import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { authenticateApiKey, type ApiKeyContext } from "../middleware/api-key";
import { parseRequirements, serializeRequirements, normalizeLeadRequirements } from "../lib/lead-requirements";
import { LEAD_STATUSES, computeLeadScore } from "./leads";

// Public, API-key authenticated REST API (`/api/v1`). This is what an external
// system — e.g. the Plivo AI voice agent — calls to read a lead and write back
// what it learned on a call. Every write lands in the same tables the dashboard
// reads, so changes appear in the UI immediately.
//
// Auth: send the key as `X-API-Key: gld_...` or `Authorization: Bearer gld_...`.
// The key resolves to a user; all queries are scoped to that user.
//
// See the repo's API.md for the full endpoint reference.

const router = new Hono<{ Variables: { api: ApiKeyContext } }>();

router.use("/*", async (c, next) => {
  const api = await authenticateApiKey(c);
  if (!api) {
    return c.json(
      { error: "Unauthorized", message: "Provide a valid API key via the X-API-Key header or Authorization: Bearer." },
      401,
    );
  }
  c.set("api", api);
  await next();
});

const requirementItemSchema = z.object({
  label: z.string().max(80).default(""),
  value: z.string().max(1000).default(""),
});
const requirementsListSchema = z.array(requirementItemSchema).max(50);

const leadFieldsSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  source: z.string().max(120).nullable().optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  value: z.number().nullable().optional(),
  notes: z.string().max(20000).nullable().optional(),
  interest: z.string().max(120).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  urgency: z.string().max(120).nullable().optional(),
  budget_min: z.number().nullable().optional(),
  budget_max: z.number().nullable().optional(),
  requirements: requirementsListSchema.optional(),
});

const createLeadSchema = leadFieldsSchema.extend({ name: z.string().min(1).max(200) });
const patchLeadSchema = leadFieldsSchema;

type Row = Record<string, unknown>;

async function findLead(userId: number, idOrPrefix: string): Promise<Row | undefined> {
  const db = await getDb();
  return (
    await db.execute({
      sql: "SELECT * FROM leads WHERE user_id = ? AND (id = ? OR substr(id, 1, 8) = ?) LIMIT 1",
      args: [userId, idOrPrefix, idOrPrefix],
    })
  ).rows[0] as unknown as Row | undefined;
}

function notFound(c: { json: (b: unknown, s: number) => Response }, id: string) {
  return c.json({ error: "Not found", message: `No lead matching "${id}" for this account.` }, 404);
}

// ---- Identity -------------------------------------------------------------

router.get("/me", async (c) => {
  const api = c.get("api");
  return c.json({
    key: { id: api.keyId, name: api.keyName },
    user: { id: api.userId, name: api.name, email: api.email },
  });
});

// ---- Leads ----------------------------------------------------------------

router.get("/leads", async (c) => {
  const api = c.get("api");
  const db = await getDb();
  const rows = (
    await db.execute({
      sql: "SELECT * FROM leads WHERE user_id = ? ORDER BY COALESCE(last_activity, created_at) DESC",
      args: [api.userId],
    })
  ).rows as unknown as Row[];

  const q = c.req.query("query")?.trim().toLowerCase();
  const status = c.req.query("status")?.trim();
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);

  const filtered = rows
    .filter((r) => (status ? r.status === status : true))
    .filter((r) =>
      q
        ? [r.name, r.email, r.phone, r.company, r.city].some((v) => String(v ?? "").toLowerCase().includes(q))
        : true,
    )
    .slice(0, limit);

  return c.json(filtered.map(normalizeLeadRequirements));
});

router.post("/leads", async (c) => {
  const api = c.get("api");
  try {
    const data = createLeadSchema.parse(await c.req.json());
    const db = await getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const score = computeLeadScore({ ...data, requirements: undefined });
    await db.execute({
      sql: `INSERT INTO leads
        (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at,
         interest, category, budget_min, budget_max, region, urgency, requirements)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, api.userId, data.name, data.email ?? null, data.phone ?? null, data.company ?? null,
        data.source ?? "api", data.status ?? "new", score, data.value ?? null, data.city ?? null, data.notes ?? null,
        now, now, data.interest ?? null, data.category ?? null, data.budget_min ?? null, data.budget_max ?? null,
        data.region ?? null, data.urgency ?? null, serializeRequirements(data.requirements),
      ],
    });
    const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0] as unknown as Row;
    return c.json(normalizeLeadRequirements(row), 201);
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

router.get("/leads/:id", async (c) => {
  const api = c.get("api");
  const row = await findLead(api.userId, c.req.param("id"));
  if (!row) return notFound(c, c.req.param("id"));
  return c.json(normalizeLeadRequirements(row));
});

router.patch("/leads/:id", async (c) => {
  const api = c.get("api");
  try {
    const id = c.req.param("id");
    const data = patchLeadSchema.parse(await c.req.json());
    const db = await getDb();
    const existing = await findLead(api.userId, id);
    if (!existing) return notFound(c, id);

    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (k === "requirements") {
        sets.push("requirements = ?");
        vals.push(serializeRequirements(v));
        continue;
      }
      sets.push(`${k} = ?`);
      vals.push(v as string | number | null);
    }
    if (!sets.length) {
      return c.json({ error: "Bad request", message: "No updatable fields were provided." }, 400);
    }

    // Keep the auto-score in step with the new field values.
    const merged = { ...existing, ...data, requirements: data.requirements ?? parseRequirements(existing.requirements) };
    sets.push("score = ?");
    vals.push(computeLeadScore(merged));
    sets.push("last_activity = ?");
    vals.push(new Date().toISOString());
    vals.push(String(existing.id), api.userId);

    await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args: vals });
    const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [String(existing.id)] })).rows[0] as unknown as Row;
    return c.json(normalizeLeadRequirements(row));
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

// ---- Requirements ---------------------------------------------------------

router.put("/leads/:id/requirements", async (c) => {
  const api = c.get("api");
  try {
    const id = c.req.param("id");
    const body = z.object({ requirements: requirementsListSchema }).parse(await c.req.json());
    const db = await getDb();
    const existing = await findLead(api.userId, id);
    if (!existing) return notFound(c, id);
    const clean = parseRequirements(body.requirements);
    await db.execute({
      sql: "UPDATE leads SET requirements = ?, last_activity = ? WHERE id = ? AND user_id = ?",
      args: [serializeRequirements(clean), new Date().toISOString(), String(existing.id), api.userId],
    });
    const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [String(existing.id)] })).rows[0] as unknown as Row;
    return c.json(normalizeLeadRequirements(row));
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

router.post("/leads/:id/requirements", async (c) => {
  const api = c.get("api");
  try {
    const id = c.req.param("id");
    const body = z
      .object({ label: z.string().min(1).max(80), value: z.string().max(1000).default("") })
      .parse(await c.req.json());
    const db = await getDb();
    const existing = await findLead(api.userId, id);
    if (!existing) return notFound(c, id);

    const list = parseRequirements(existing.requirements);
    const key = body.label.trim().toLowerCase();
    const idx = list.findIndex((r) => r.label.trim().toLowerCase() === key);
    if (idx >= 0) list[idx] = { label: body.label.trim(), value: body.value };
    else list.push({ label: body.label.trim(), value: body.value });

    await db.execute({
      sql: "UPDATE leads SET requirements = ?, last_activity = ? WHERE id = ? AND user_id = ?",
      args: [serializeRequirements(list), new Date().toISOString(), String(existing.id), api.userId],
    });
    const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [String(existing.id)] })).rows[0] as unknown as Row;
    return c.json(normalizeLeadRequirements(row));
  } catch (e) {
    return c.json({ error: "Bad request", message: (e as Error).message }, 400);
  }
});

router.delete("/leads/:id/requirements/:label", async (c) => {
  const api = c.get("api");
  const id = c.req.param("id");
  const label = decodeURIComponent(c.req.param("label")).trim().toLowerCase();
  const db = await getDb();
  const existing = await findLead(api.userId, id);
  if (!existing) return notFound(c, id);

  const list = parseRequirements(existing.requirements).filter((r) => r.label.trim().toLowerCase() !== label);
  await db.execute({
    sql: "UPDATE leads SET requirements = ?, last_activity = ? WHERE id = ? AND user_id = ?",
    args: [serializeRequirements(list), new Date().toISOString(), String(existing.id), api.userId],
  });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [String(existing.id)] })).rows[0] as unknown as Row;
  return c.json(normalizeLeadRequirements(row));
});

export default router;
