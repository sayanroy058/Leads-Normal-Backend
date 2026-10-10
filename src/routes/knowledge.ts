import { Hono } from "hono";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { getDb } from "../db";
import { authenticate, type AuthedUser } from "../middleware/auth";
import {
  getOrCreateKb,
  isValidSlug,
  slugify,
  getKnowledgeContext,
  type KbRow,
} from "../lib/knowledge";

// Owner-facing Knowledge Base API. Every route is authenticated and scoped to
// the caller's own KB (one per user) — a user can never read or mutate another
// user's knowledge base.
//
// Simplified model: instead of sections / FAQ / file uploads / website crawl,
// the user writes all their business details (property details, prices, services,
// policies, etc.) in a single free-text "content" field. That text is used to
// ground AI features and published as a read-only public page.

const router = new Hono();

async function loadKb(db: Client, user: AuthedUser): Promise<KbRow> {
  return getOrCreateKb(db, user.id, user.name ?? user.email);
}

// ---- Bundle (everything the editor needs in one round-trip) ----
router.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  return c.json({ kb });
});

// ---- Profile + content ----
const profileSchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().max(50000).optional(),
  slug: z.string().max(60).optional(),
});

router.put("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = profileSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);

  const sets: string[] = [];
  const vals: (string | null)[] = [];

  if (data.title !== undefined) {
    sets.push("title = ?");
    vals.push(data.title?.trim() || null);
  }
  if (data.content !== undefined) {
    sets.push("content = ?");
    vals.push(data.content?.trim() || null);
  }

  if (data.slug !== undefined) {
    const slug = slugify(data.slug);
    if (!isValidSlug(slug)) return c.json({ error: "That URL slug is not allowed — use letters, numbers and dashes." }, 400);
    if (slug !== kb.slug) {
      const taken = (await db.execute({ sql: "SELECT id FROM knowledge_bases WHERE slug = ? AND id != ?", args: [slug, kb.id] })).rows[0];
      if (taken) return c.json({ error: "That URL is already taken." }, 409);
      sets.push("slug = ?");
      vals.push(slug);
    }
  }

  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(kb.id);
  await db.execute({ sql: `UPDATE knowledge_bases SET ${sets.join(", ")} WHERE id = ?`, args: vals });

  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});

// ---- Publish / unpublish ----
router.post("/publish", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!kb.slug || !isValidSlug(kb.slug)) return c.json({ error: "Set a valid URL slug before publishing" }, 400);
  const now = new Date().toISOString();
  await db.execute({ sql: "UPDATE knowledge_bases SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", args: [now, now, kb.id] });
  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});

router.post("/unpublish", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  await db.execute({ sql: "UPDATE knowledge_bases SET status = 'draft', updated_at = ? WHERE id = ?", args: [new Date().toISOString(), kb.id] });
  const row = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [kb.id] })).rows[0];
  return c.json(row);
});

// ---- Retrieval preview (see what the AI would ground on) ----
router.post("/preview", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { query } = z.object({ query: z.string().max(500) }).parse(await c.req.json());
  const db = await getDb();
  const context = await getKnowledgeContext(db, user.id, query ?? "");
  return c.json({ context });
});

export default router;
