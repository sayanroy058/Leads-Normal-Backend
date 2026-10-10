// Per-user Knowledge Base.
//
// Each user has exactly ONE knowledge base. Instead of structured sections/FAQ/
// file uploads/web crawls, the user writes all their business details in a
// single free-text field (property details, prices, services, policies, etc.).
// That text is used to ground the AI features (chat / email / WhatsApp / voice)
// and is published as a read-only public page.
// Everything here is strictly tenant-scoped by user_id / kb_id.

import type { Client } from "@libsql/client";

export interface KbRow {
  id: string;
  user_id: number;
  slug: string | null;
  title: string | null;
  content: string | null;
  status: "draft" | "published";
  published_at: string | null;
  created_at: string;
  updated_at: string | null;
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
    sql: "INSERT INTO knowledge_bases (id, user_id, slug, title, content, status, created_at) VALUES (?, ?, ?, ?, NULL, 'draft', ?)",
    args: [id, userId, slug, title, now],
  });
  return (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE id = ?", args: [id] })).rows[0] as unknown as KbRow;
}

/**
 * Return the user's free-text knowledge base content for AI grounding.
 * Bounded in size so it can't blow the model's prompt budget. Returns "" when
 * the user has no KB or no content written yet.
 */
export async function getKnowledgeContext(
  db: Client,
  userId: number,
  _query: string,
  opts: { maxChars?: number } = {},
): Promise<string> {
  const kb = (await db.execute({ sql: "SELECT * FROM knowledge_bases WHERE user_id = ?", args: [userId] }))
    .rows[0] as unknown as KbRow | undefined;
  if (!kb || !kb.content) return "";

  // Send the full content to the AI. The storage schema allows up to 50 000
  // characters; match that so nothing the user saves is ever cropped for the
  // AI, the preview, or any other consumer. The model's context window is far
  // larger than this, so there is no practical downside.
  const maxChars = opts.maxChars ?? 50000;
  let out = kb.content.trim();
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  return out;
}

// ---------------------------------------------------------------------------
// Public projection
// ---------------------------------------------------------------------------

export interface PublicKb {
  slug: string;
  title: string | null;
  content: string | null;
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

  return {
    slug: kb.slug ?? slug,
    title: kb.title,
    content: kb.content,
    published_at: kb.published_at,
    updated_at: kb.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers only used by the knowledge route (profile save / touch)
// ---------------------------------------------------------------------------

export function slugFromTitle(title: string): string {
  return slugify(title);
}
