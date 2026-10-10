import { Hono } from "hono";
import { getDb } from "../db";
import { getPublicKb } from "../lib/knowledge";

// Public, unauthenticated Knowledge Base API. Exposes ONLY the published
// projection of a KB (title + free-text content) — never the owner id,
// leads, or credentials. Mounted at /api/public.

const router = new Hono();

router.get("/kb/:slug", async (c) => {
  const db = await getDb();
  const kb = await getPublicKb(db, c.req.param("slug"));
  if (!kb) return c.json({ error: "Knowledge base not found" }, 404);
  // Safe to cache briefly; content changes via explicit edits.
  c.header("Cache-Control", "public, max-age=60");
  return c.json(kb);
});

export default router;
