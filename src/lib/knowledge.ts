// Per-user Knowledge Base.
//
// Each user has exactly ONE knowledge base (their business profile). It is
// authored in the app, published as a read-only public page, and used to
// ground the AI features (chat / email / WhatsApp / voice) in that user's own
// details. Everything here is strictly tenant-scoped by user_id / kb_id — a
// KB must never be visible to, or retrievable by, another tenant.

import type { Client, InStatement } from "@libsql/client";

export interface KbRow {
  id: string;
  user_id: number;
  slug: string | null;
  title: string | null;
  tagline: string | null;
  description: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_website: string | null;
  contact_address: string | null;
  status: "draft" | "published";
  published_at: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface KbSection {
  id: string;
  kb_id: string;
  kind: string | null;
  title: string | null;
  body: string | null;
  position: number;
}

export interface KbEntry {
  id: string;
  kb_id: string;
  question: string;
  answer: string;
  tags: string | null;
  position: number;
}

export interface KbSource {
  id: string;
  kb_id: string;
  type: "file" | "url";
  name: string | null;
  status: string | null;
  fetched_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

// Paths the public site already owns — a KB slug must not shadow them.
const RESERVED_SLUGS = new Set([
  "app", "auth", "api", "kb", "admin", "blogs", "blog", "pricing", "marketing",
  "all-blogs", "industries", "new", "settings", "public", "assets", "favicon.ico",
]);

/** Turn arbitrary text into a URL-safe slug (a-z, 0-9, single dashes). */
export function slugify(input: string): string {
  return (input ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug);
}

/** Find a slug nobody else has claimed (appends -2, -3, … as needed). */
async function uniqueSlug(db: Client, base: string): Promise<string> {
  let slug = slugify(base) || `kb-${crypto.randomUUID().slice(0, 6)}`;
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-1`;
  let candidate = slug;
  for (let i = 2; i < 60; i++) {
    const hit = (await db.execute({ sql: "SELECT id FROM knowledge_bases WHERE slug = ?", args: [candidate] })).rows[0];
    if (!hit) return candidate;
    candidate = `${slug}-${i}`;
  }
  return `${slug}-${crypto.randomUUID().slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// HTML → text, and chunking
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–",
  "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”",
};

/**
 * Reduce an HTML document to readable plain text without a parser dependency:
 * drop scripts/styles/svg, turn block tags into line breaks, strip the rest of
 * the tags, decode common entities, and collapse whitespace. Good enough for
 * grounding an LLM — not a full DOM implementation.
 */
export function htmlToText(html: string): string {
  let s = (html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) {
    s = s.split(entity).join(char);
  }
  s = s.replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, num) => {
    const code = parseInt(num, hex ? 16 : 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line, i, arr) => line !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Split long text into overlapping chunks suitable for retrieval. */
export function chunkText(text: string, maxLen = 1200, overlap = 150): string[] {
  const clean = (text ?? "").replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let cur = "";
  for (const para of clean.split(/\n{2,}/)) {
    if ((cur ? cur.length + 2 : 0) + para.length <= maxLen) {
      cur = cur ? `${cur}\n\n${para}` : para;
      continue;
    }
    if (cur) chunks.push(cur);
    if (para.length <= maxLen) {
      cur = para;
    } else {
      for (let i = 0; i < para.length; i += maxLen - overlap) chunks.push(para.slice(i, i + maxLen));
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// KB lookup / creation
// ---------------------------------------------------------------------------

export async function getOrCreateKb(db: Client, userId: number, fallbackName?: string | null): Promise<KbRow> {
  const existing = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE user_id = ?", args: [userId] }))
    .rows[0] as unknown as KbRow | undefined;
  if (existing) return existing;

  const id = crypto.randomUUID();
  const title = (fallbackName ?? "").trim() || "My Business";
  const slug = await uniqueSlug(db, title);
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO knowledge_bases (id, user_id, slug, title, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)",
    args: [id, userId, slug, title, now],
  });
  return (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [id] })).rows[0] as unknown as KbRow;
}

// ---------------------------------------------------------------------------
// Chunk indexing + retrieval
// ---------------------------------------------------------------------------

export interface ChunkRow {
  text: string;
  source_id: string | null;
}

/** Append chunks for a source and mirror them into the FTS index (best-effort). */
export async function addChunks(db: Client, kbId: string, sourceId: string | null, texts: string[]): Promise<void> {
  const clean = texts.map((t) => t.trim()).filter(Boolean);
  if (!clean.length) return;
  const now = new Date().toISOString();
  const rows = clean.map((text) => ({ id: crypto.randomUUID(), text }));

  await db.batch(
    rows.map(
      (r): InStatement => ({
        sql: "INSERT INTO kb_chunks (id, kb_id, source_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
        args: [r.id, kbId, sourceId, r.text, now],
      }),
    ),
    "write",
  );

  try {
    await db.batch(
      rows.map(
        (r): InStatement => ({
          sql: "INSERT INTO kb_chunks_fts (chunk_id, kb_id, text) VALUES (?, ?, ?)",
          args: [r.id, kbId, r.text],
        }),
      ),
      "write",
    );
  } catch {
    // FTS5 unavailable — retrieval falls back to LIKE.
  }
}

/** Remove every chunk belonging to a source (both the table and the FTS index). */
export async function deleteSourceChunks(db: Client, kbId: string, sourceId: string): Promise<void> {
  try {
    await db.execute({
      sql: "DELETE FROM kb_chunks_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE kb_id = ? AND source_id = ?)",
      args: [kbId, sourceId],
    });
  } catch {
    // No FTS index — nothing to clean there.
  }
  await db.execute({ sql: "DELETE FROM kb_chunks WHERE kb_id = ? AND source_id = ?", args: [kbId, sourceId] });
}

/** Delete a source and all of its indexed content. */
export async function deleteSource(db: Client, kbId: string, sourceId: string): Promise<void> {
  await deleteSourceChunks(db, kbId, sourceId);
  await db.execute({ sql: "DELETE FROM kb_crawl_jobs WHERE kb_id = ? AND source_id = ?", args: [kbId, sourceId] });
  await db.execute({ sql: "DELETE FROM kb_sources WHERE id = ? AND kb_id = ?", args: [sourceId, kbId] });
}

/** Build a safe FTS5 MATCH expression from free text (prefix OR of tokens). */
function ftsMatch(query: string): string {
  const tokens = Array.from(new Set((query ?? "").toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])).slice(0, 12);
  return tokens.map((t) => `${t}*`).join(" OR ");
}

/** Top matching chunks for a query, scoped to one KB. */
export async function searchChunks(db: Client, kbId: string, query: string, k = 6): Promise<ChunkRow[]> {
  const match = ftsMatch(query);
  if (match) {
    try {
      const rows = (await db.execute({
        sql: `SELECT c.text AS text, c.source_id AS source_id
              FROM kb_chunks_fts f JOIN kb_chunks c ON c.id = f.chunk_id
              WHERE f.kb_id = ? AND kb_chunks_fts MATCH ?
              ORDER BY bm25(kb_chunks_fts) LIMIT ?`,
        args: [kbId, match, k],
      })).rows as unknown as ChunkRow[];
      if (rows.length) return rows;
    } catch {
      // FTS5 missing/bad query — fall through to LIKE.
    }
  }
  const like = match && query.trim() ? `%${query.trim().slice(0, 40)}%` : "%";
  return (await db.execute({
    sql: "SELECT text, source_id FROM kb_chunks WHERE kb_id = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?",
    args: [kbId, like, k],
  })).rows as unknown as ChunkRow[];
}

/**
 * Assemble the grounding context for a user's AI prompt: curated profile +
 * sections + FAQ, plus the top chunks matching the query. Bounded in size so
 * it can't blow the model's prompt budget. Returns "" when the user has no KB.
 */
export async function getKnowledgeContext(
  db: Client,
  userId: number,
  query: string,
  opts: { maxChars?: number; chunks?: number } = {},
): Promise<string> {
  const kb = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE user_id = ?", args: [userId] }))
    .rows[0] as unknown as KbRow | undefined;
  if (!kb) return "";

  const sections = (await db.execute({
    sql: "SELECT kind, title, body FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id],
  })).rows as unknown as { kind: string | null; title: string | null; body: string | null }[];

  const entries = (await db.execute({
    sql: "SELECT question, answer FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC LIMIT 40",
    args: [kb.id],
  })).rows as unknown as { question: string; answer: string }[];

  const chunks = await searchChunks(db, kb.id, query, opts.chunks ?? 6);

  const parts: string[] = [];
  const header = [kb.title, kb.tagline].filter(Boolean).join(" — ");
  if (header) parts.push(`Business: ${header}`);
  if (kb.description) parts.push(`About: ${kb.description}`);
  const contact = [kb.contact_email, kb.contact_phone, kb.contact_website, kb.contact_address].filter(Boolean);
  if (contact.length) parts.push(`Contact: ${contact.join(" · ")}`);
  for (const s of sections) {
    const body = (s.body ?? "").trim();
    if (body) parts.push(`${s.title ?? s.kind ?? "Section"}: ${body}`);
  }
  if (entries.length) {
    parts.push("FAQ:\n" + entries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join("\n"));
  }
  if (chunks.length) {
    parts.push("Details:\n" + chunks.map((c) => c.text).join("\n---\n"));
  }

  let out = parts.join("\n\n").trim();
  const maxChars = opts.maxChars ?? 6000;
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export interface PublicKb {
  slug: string;
  title: string | null;
  tagline: string | null;
  description: string | null;
  contact: { email: string | null; phone: string | null; website: string | null; address: string | null };
  sections: { kind: string | null; title: string | null; body: string | null }[];
  faqs: { question: string; answer: string }[];
  published_at: string | null;
  updated_at: string | null;
}

/** The published, public-safe projection of a KB — never includes owner ids. */
export async function getPublicKb(db: Client, slug: string): Promise<PublicKb | null> {
  const kb = (await db.execute({
    sql: "SELECT * FROM knowledge_bases WHERE slug = ? AND status = 'published'",
    args: [slug],
  })).rows[0] as unknown as KbRow | undefined;
  if (!kb) return null;

  const sections = (await db.execute({
    sql: "SELECT kind, title, body FROM kb_sections WHERE kb_id = ? ORDER BY position ASC, created_at ASC",
    args: [kb.id],
  })).rows as unknown as { kind: string | null; title: string | null; body: string | null }[];

  const faqs = (await db.execute({
    sql: "SELECT question, answer FROM kb_entries WHERE kb_id = ? ORDER BY position ASC, created_at ASC LIMIT 100",
    args: [kb.id],
  })).rows as unknown as { question: string; answer: string }[];

  return {
    slug: kb.slug ?? slug,
    title: kb.title,
    tagline: kb.tagline,
    description: kb.description,
    contact: {
      email: kb.contact_email,
      phone: kb.contact_phone,
      website: kb.contact_website,
      address: kb.contact_address,
    },
    sections: sections.map((s) => ({ kind: s.kind, title: s.title, body: s.body })),
    faqs,
    published_at: kb.published_at,
    updated_at: kb.updated_at,
  };
}
