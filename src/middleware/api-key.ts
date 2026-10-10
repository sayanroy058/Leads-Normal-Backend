import { getDb } from "../db";
import { hashApiKey } from "../lib/api-keys";

// Authenticates requests to the external REST API (routes/external.ts) using
// an API key created on the dashboard. The key may be sent either as
//   X-API-Key: gld_...
// or
//   Authorization: Bearer gld_...
//
// The key resolves to a user; every external route is scoped to that user, so
// one key can never read or write another tenant's leads.

export interface ApiKeyContext {
  keyId: string;
  userId: number;
  keyName: string | null;
  name: string | null;
  email: string;
}

type HeaderCtx = { req: { header: (name: string) => string | undefined } };

function presentedKey(c: HeaderCtx): string | null {
  const direct = c.req.header("X-API-Key") ?? c.req.header("x-api-key");
  if (direct?.trim()) return direct.trim();
  const auth = c.req.header("Authorization") ?? c.req.header("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
}

export async function authenticateApiKey(c: HeaderCtx): Promise<ApiKeyContext | null> {
  const raw = presentedKey(c);
  if (!raw) return null;

  const db = await getDb();
  const row = (
    await db.execute({
      sql: `SELECT k.id AS key_id, k.name AS key_name, k.user_id, u.name, u.email, u.disabled
            FROM api_keys k JOIN users u ON u.id = k.user_id
            WHERE k.key_hash = ? AND k.revoked_at IS NULL
            LIMIT 1`,
      args: [hashApiKey(raw)],
    })
  ).rows[0] as unknown as
    | { key_id: string; key_name: string | null; user_id: number; name: string | null; email: string; disabled: number }
    | undefined;
  if (!row || row.disabled) return null;

  // Record usage; never block the request on this.
  db.execute({ sql: "UPDATE api_keys SET last_used_at = ? WHERE id = ?", args: [new Date().toISOString(), row.key_id] }).catch(
    () => {},
  );

  return { keyId: row.key_id, userId: row.user_id, keyName: row.key_name, name: row.name, email: row.email };
}
