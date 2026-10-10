import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";
import { generateApiKey, hashApiKey, apiKeyDisplay } from "../lib/api-keys";

// Dashboard-side management of API keys (session-authenticated). The external
// API itself lives in routes/external.ts and authenticates with these keys.

const router = new Hono();

const createSchema = z.object({ name: z.string().max(80).optional() });

router.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const rows = (
    await db.execute({
      sql: "SELECT id, name, prefix, last_used_at, revoked_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      args: [user.id],
    })
  ).rows;
  return c.json(rows);
});

router.post("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  try {
    const data = createSchema.parse(await c.req.json().catch(() => ({})));
    const db = await getDb();
    const raw = generateApiKey();
    const id = crypto.randomUUID();
    const name = data.name?.trim() || null;
    await db.execute({
      sql: "INSERT INTO api_keys (id, user_id, name, key_hash, prefix) VALUES (?, ?, ?, ?, ?)",
      args: [id, user.id, name, hashApiKey(raw), apiKeyDisplay(raw)],
    });
    // The raw key is returned exactly once — only its hash is stored.
    return c.json({ id, name, prefix: apiKeyDisplay(raw), key: raw, created_at: new Date().toISOString() }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.delete("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  // Soft revoke: keeps the audit trail and makes the key stop working immediately.
  await db.execute({
    sql: "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    args: [new Date().toISOString(), c.req.param("id"), user.id],
  });
  return c.json({ success: true });
});

export default router;
