import type { Client } from "@libsql/client";
import { listMessages, getMessage, type MailerConfig } from "./mailer";
import { insertEvent } from "./events";
import { computeLeadScore } from "../routes/leads";

/** Pull the email address out of a display string like "Name <user@example.com>". */
function extractEmail(from: unknown): string | null {
  if (!from) return null;
  const s = String(from).trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s) || null;
}

/** Pull the display name out of "Name <user@example.com>", if present. */
function extractName(from: unknown): string | null {
  if (!from) return null;
  const m = String(from).trim().match(/^(.*?)\s*<[^<>]+>$/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Crude HTML → text for preview bodies when no plain-text part exists. */
function stripHtml(html: unknown): string | null {
  if (!html) return null;
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/**
 * Pull the latest inbound mail from a user's own Gmail inbox into
 * email_messages, matching/creating leads scoped to that user. Shared by the
 * manual "Sync inbox" route and the admin panel's first-sync-on-connect.
 */
export async function syncUserInbox(db: Client, userId: number, mailCfg: MailerConfig): Promise<{ synced: number; total: number }> {
  const res = await listMessages({ limit: 50 }, mailCfg);
  const msgs = Array.isArray(res.messages) ? res.messages : [];

  let synced = 0;
  for (const m of msgs) {
    if (!m.message_id) continue;
    if (Array.isArray(m.labels) && m.labels.includes("sent")) continue; // outbound copy
    const existing = (await db.execute({ sql: "SELECT id FROM email_messages WHERE agentmail_message_id = ?", args: [m.message_id] })).rows[0];
    if (existing) continue; // already synced
    let full = m;
    try {
      full = await getMessage(m.message_id, mailCfg); // list omits bodies — fetch content
    } catch { /* keep metadata-only */ }
    const fromEmail = extractEmail(full.from);
    const toEmail = Array.isArray(full.to) ? full.to[0] ?? null : typeof full.to === "string" ? full.to : null;
    const body = full.extracted_text ?? full.text ?? stripHtml(full.extracted_html ?? full.html);
    let leadId: string | null = null;
    if (fromEmail) {
      // Only match against this user's own leads — a shared inbox must not
      // leak sync results into another user's lead list.
      const lead = (await db.execute({ sql: "SELECT id FROM leads WHERE email = ? AND user_id = ?", args: [fromEmail, userId] })).rows[0] as unknown as
        | { id: string }
        | undefined;
      if (lead) {
        leadId = lead.id;
      } else {
        // Unmatched sender → create a contact from the inbound email, owned by this user.
        const now = new Date().toISOString();
        const newId = crypto.randomUUID();
        const name = extractName(full.from) ?? fromEmail;
        await db.execute({
          sql: "INSERT INTO leads (id, user_id, name, email, source, status, score, last_activity, created_at) VALUES (?, ?, ?, ?, 'inbound email', 'new', ?, ?, ?)",
          args: [newId, userId, name, fromEmail, computeLeadScore({ email: fromEmail, name }), now, now],
        });
        leadId = newId;
      }
    }
    const emailRowId = crypto.randomUUID();
    const emailCreatedAt = full.timestamp ?? new Date().toISOString();
    await db.execute({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, from_email, to_email, agentmail_message_id, agentmail_thread_id, created_at) VALUES (?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?)",
      args: [emailRowId, leadId, full.subject ?? null, body, fromEmail, toEmail, full.message_id, full.thread_id ?? null, emailCreatedAt],
    });
    await insertEvent(db, {
      lead_id: leadId,
      channel: "email",
      type: "email",
      direction: "inbound",
      handled_by: "unhandled",
      action: "received",
      summary: full.subject ?? "(no subject)",
      content: body,
      source_ref: emailRowId,
      metadata: { from: fromEmail, message_id: full.message_id },
      created_at: emailCreatedAt,
    });
    synced++;
  }
  return { synced, total: msgs.length };
}
