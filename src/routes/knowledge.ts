import { Hono } from "hono";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { getDb } from "../db";
import { authenticate, type AuthedUser } from "../middleware/auth";
import {
  getOrCreateKb,
  isValidSlug,
  slugify,
  addChunks,
  chunkText,
  htmlToText,
  deleteSource,
  getKnowledgeContext,
  type KbRow,
} from "../lib/knowledge";
import { startCrawl, processCrawl, getCrawlJob, cancelCrawl } from "../lib/crawler";

// Owner-facing Knowledge Base API. Every route is authenticated and scoped to
// the caller's own KB (one per user) — a user can never read or mutate another
// user's knowledge base.

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

  const sections = (await db.execute({
    sql: "SELECT * FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id],
  })).rows;
  const entries = (await db.execute({
    sql: "SELECT * FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id],
  })).rows;
  const sources = (await db.execute({
    sql: "SELECT id, type, name, status, fetched_at, created_at FROM kb_sources WHERE kb_id = ? ORDER BY created_at DESC",
    args: [kb.id],
  })).rows;
  const crawlJobs = (await db.execute({
    sql: "SELECT id, source_id, source_url, host, limit_pages, max_depth, status, pages_found, pages_done, error, created_at, updated_at FROM kb_crawl_jobs WHERE kb_id = ? ORDER BY created_at DESC LIMIT 10",
    args: [kb.id],
  })).rows;

  return c.json({ kb, sections, entries, sources, crawlJobs });
});

// ---- Profile ----
const profileSchema = z.object({
  title: z.string().max(200).optional(),
  tagline: z.string().max(300).optional(),
  description: z.string().max(4000).optional(),
  contact_email: z.string().max(200).optional(),
  contact_phone: z.string().max(60).optional(),
  contact_website: z.string().max(300).optional(),
  contact_address: z.string().max(400).optional(),
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
  for (const key of ["title", "tagline", "description", "contact_email", "contact_phone", "contact_website", "contact_address"] as const) {
    if (data[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(data[key]?.trim() || null);
    }
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

// ---- Sections ----
const sectionSchema = z.object({
  kind: z.string().max(40).optional(),
  title: z.string().max(200).optional(),
  body: z.string().max(20000).optional(),
  position: z.number().optional(),
});

router.post("/sections", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = sectionSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_sections (id, kb_id, kind, title, body, position) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, kb.id, d.kind ?? "custom", d.title ?? null, d.body ?? null, d.position ?? 0],
  });
  const row = (await db.execute({ sql: "SELECT * FROM kb_sections WHERE id = ?", args: [id] })).rows[0];
  await touch(db, kb.id);
  return c.json(row);
});

router.put("/sections/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = sectionSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!(await ownsRow(db, "kb_sections", c.req.param("id"), kb.id))) return c.json({ error: "Not found" }, 404);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (d.kind !== undefined) { sets.push("kind = ?"); vals.push(d.kind); }
  if (d.title !== undefined) { sets.push("title = ?"); vals.push(d.title); }
  if (d.body !== undefined) { sets.push("body = ?"); vals.push(d.body); }
  if (d.position !== undefined) { sets.push("position = ?"); vals.push(d.position); }
  if (sets.length) {
    vals.push(c.req.param("id"));
    await db.execute({ sql: `UPDATE kb_sections SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }
  await touch(db, kb.id);
  return c.json({ success: true });
});

router.delete("/sections/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!(await ownsRow(db, "kb_sections", c.req.param("id"), kb.id))) return c.json({ error: "Not found" }, 404);
  await db.execute({ sql: "DELETE FROM kb_sections WHERE id = ?", args: [c.req.param("id")] });
  await touch(db, kb.id);
  return c.json({ success: true });
});

// ---- FAQ entries ----
const entrySchema = z.object({
  question: z.string().max(500).optional(),
  answer: z.string().max(8000).optional(),
  tags: z.string().max(300).optional(),
  position: z.number().optional(),
});

router.post("/entries", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = entrySchema.parse(await c.req.json());
  if (!d.question?.trim() || !d.answer?.trim()) return c.json({ error: "Question and answer are required" }, 400);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO kb_entries (id, kb_id, question, answer, tags, position) VALUES (?, ?, ?, ?, ?, ?)",
    args: [id, kb.id, d.question.trim(), d.answer.trim(), d.tags ?? null, d.position ?? 0],
  });
  const row = (await db.execute({ sql: "SELECT * FROM kb_entries WHERE id = ?", args: [id] })).rows[0];
  await touch(db, kb.id);
  return c.json(row);
});

router.put("/entries/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = entrySchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!(await ownsRow(db, "kb_entries", c.req.param("id"), kb.id))) return c.json({ error: "Not found" }, 404);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (d.question !== undefined) { sets.push("question = ?"); vals.push(d.question); }
  if (d.answer !== undefined) { sets.push("answer = ?"); vals.push(d.answer); }
  if (d.tags !== undefined) { sets.push("tags = ?"); vals.push(d.tags); }
  if (d.position !== undefined) { sets.push("position = ?"); vals.push(d.position); }
  if (sets.length) {
    vals.push(c.req.param("id"));
    await db.execute({ sql: `UPDATE kb_entries SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  }
  await touch(db, kb.id);
  return c.json({ success: true });
});

router.delete("/entries/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!(await ownsRow(db, "kb_entries", c.req.param("id"), kb.id))) return c.json({ error: "Not found" }, 404);
  await db.execute({ sql: "DELETE FROM kb_entries WHERE id = ?", args: [c.req.param("id")] });
  await touch(db, kb.id);
  return c.json({ success: true });
});

// ---- File uploads ----
// Text-like files only (txt/md/csv/json/xml/html). We extract their text and
// index it; binary formats (pdf/docx) are rejected with a clear message.
const MAX_FILE_BYTES = 2_000_000;
const fileSchema = z.object({
  files: z.array(z.object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(120).optional(),
    data: z.string().min(1),
  })).min(1).max(10),
});

function fileToText(filename: string, contentType: string | undefined, buffer: Buffer): string | null {
  const name = filename.toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  const isHtml = /\.(html?|xhtml)$/.test(name) || ct.includes("html");
  if (isHtml) return htmlToText(buffer.toString("utf8"));
  const textLike =
    /\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log|rtf)$/.test(name) ||
    /^text\//.test(ct) ||
    /json|xml|csv|javascript|yaml/.test(ct);
  if (!textLike) return null;
  return buffer.toString("utf8");
}

router.post("/files", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = fileSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);

  const indexed: { filename: string; chunks: number }[] = [];
  const skipped: { filename: string; reason: string }[] = [];
  for (const f of d.files) {
    const buffer = Buffer.from(f.data, "base64");
    if (buffer.byteLength > MAX_FILE_BYTES) {
      skipped.push({ filename: f.filename, reason: "too large (max 2 MB)" });
      continue;
    }
    const text = fileToText(f.filename, f.contentType, buffer);
    if (text === null) {
      skipped.push({ filename: f.filename, reason: "unsupported file type (use text, Markdown, CSV, JSON, HTML)" });
      continue;
    }
    const chunks = chunkText(text);
    if (!chunks.length) {
      skipped.push({ filename: f.filename, reason: "no readable text found" });
      continue;
    }
    const sourceId = crypto.randomUUID();
    await db.execute({
      sql: "INSERT INTO kb_sources (id, kb_id, type, name, status, fetched_at) VALUES (?, ?, 'file', ?, 'ready', ?)",
      args: [sourceId, kb.id, f.filename, new Date().toISOString()],
    });
    await addChunks(db, kb.id, sourceId, chunks);
    indexed.push({ filename: f.filename, chunks: chunks.length });
  }
  await touch(db, kb.id);
  return c.json({ success: true, indexed, skipped });
});

// ---- Sources ----
router.delete("/sources/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  if (!(await ownsRow(db, "kb_sources", c.req.param("id"), kb.id))) return c.json({ error: "Not found" }, 404);
  await deleteSource(db, kb.id, c.req.param("id"));
  return c.json({ success: true });
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

// ---- Website crawl ----
const crawlSchema = z.object({
  source_url: z.string().min(1).max(2000),
  limit: z.number().optional(),
  max_depth: z.number().optional(),
  include_paths: z.string().max(500).optional(),
  exclude_paths: z.string().max(500).optional(),
});

router.post("/crawl", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = crawlSchema.parse(await c.req.json());
  const db = await getDb();
  const kb = await loadKb(db, user);
  try {
    const { jobId } = await startCrawl(db, kb.id, {
      sourceUrl: d.source_url,
      limit: d.limit,
      maxDepth: d.max_depth,
      includePaths: (d.include_paths ?? "").split(","),
      excludePaths: (d.exclude_paths ?? "").split(","),
    });
    // Do the first slice of work now; the UI polls and resumes the rest.
    const job = await processCrawl(db, jobId, 20000);
    return c.json(job);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.get("/crawl/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  return c.json(job);
});

router.post("/crawl/:id/resume", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return c.json(job);
  if (job.status === "paused") {
    await db.execute({ sql: "UPDATE kb_crawl_jobs SET status = 'queued' WHERE id = ?", args: [job.id] });
  }
  return c.json(await processCrawl(db, job.id, 20000));
});

router.post("/crawl/:id/cancel", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const kb = await loadKb(db, user);
  const job = await getCrawlJob(db, c.req.param("id"));
  if (!job || job.kb_id !== kb.id) return c.json({ error: "Not found" }, 404);
  return c.json(await cancelCrawl(db, job.id));
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

// ---- helpers ----
async function ownsRow(db: Client, table: string, id: string, kbId: string): Promise<boolean> {
  const row = (await db.execute({ sql: `SELECT id FROM ${table} WHERE id = ? AND kb_id = ?`, args: [id, kbId] })).rows[0];
  return !!row;
}

async function touch(db: Client, kbId: string): Promise<void> {
  await db.execute({ sql: "UPDATE knowledge_bases SET updated_at = ? WHERE id = ?", args: [new Date().toISOString(), kbId] });
}

export default router;
