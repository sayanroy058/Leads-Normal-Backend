import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// API keys for the external REST API. Format: `gld_` + 48 hex chars.
//
// The raw key is shown to the user exactly once (on creation) and only its
// SHA-256 hash is stored, so a database leak does not expose usable keys.
// Lookups are by hash, which is deterministic and indexable.

const KEY_PREFIX = "gld_";

export function generateApiKey(): string {
  return `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
}

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Short, non-secret display id, e.g. `gld_1a2b3c4d…`. */
export function apiKeyDisplay(raw: string): string {
  return `${raw.slice(0, 12)}…`;
}

/** Constant-time compare of two hex hashes (guards against timing leaks). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
