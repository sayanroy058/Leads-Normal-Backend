import { Hono } from "hono";
import { z } from "zod";
import type { Client, InStatement } from "@libsql/client";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";
import { sendMessage, type MailerConfig } from "../lib/mailer";
import { syncUserInbox } from "../lib/email-sync";
import { insertEvent } from "../lib/events";
import { computeLeadScore } from "./leads";
import { sendText, sendMedia, whatsappConfig } from "../lib/whatsapp";

const router = new Hono();

/** Which of the given lead ids actually belong to this user. */
async function ownedLeadIds(db: Client, userId: number, leadIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(leadIds)).filter(Boolean);
  if (!ids.length) return new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = (
    await db.execute({ sql: `SELECT id FROM leads WHERE user_id = ? AND id IN (${placeholders})`, args: [userId, ...ids] })
  ).rows as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** True if the email row exists and its lead belongs to this user. */
async function userOwnsEmail(db: Client, userId: number, emailId: string): Promise<boolean> {
  const row = (
    await db.execute({
      sql: `SELECT m.id FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
      args: [emailId, userId],
    })
  ).rows[0];
  return !!row;
}

/** True if the whatsapp row exists and its lead belongs to this user. */
async function userOwnsWhatsapp(db: Client, userId: number, msgId: string): Promise<boolean> {
  const row = (
    await db.execute({
      sql: `SELECT m.id FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
      args: [msgId, userId],
    })
  ).rows[0];
  return !!row;
}

/** True if the call log row exists and its lead belongs to this user. */
async function userOwnsCall(db: Client, userId: number, callId: string): Promise<boolean> {
  const row = (
    await db.execute({
      sql: `SELECT m.id FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
      args: [callId, userId],
    })
  ).rows[0];
  return !!row;
}

/**
 * This user's own Gmail send/receive credentials (set by an admin). Falls
 * back to the global GMAIL_USER/GMAIL_APP_PASSWORD env vars when the user
 * has none configured — keeps the demo account working out of the box.
 */
async function userMailerConfig(db: Client, userId: number): Promise<MailerConfig> {
  const row = (
    await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })
  ).rows[0] as unknown as { gmail_email: string | null; gmail_app_password: string | null } | undefined;
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user — ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com",
  };
}

// File attachments: { filename, contentType, data } where data is base64.
// Kept small (2 MB / file, 6 files) to stay inside serverless body limits.
const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().min(1).max(255),
      contentType: z.string().max(120),
      data: z.string().min(1),
    })
  )
  .max(6)
  .optional();

/** Parse the stored JSON attachments column into an array (safe on bad data). */
function parseAttachments(raw: string | null | undefined): { filename: string; contentType: string; data: string }[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---- Chat ----
router.get("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({ sql: "SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 50", args: [user.id] })).rows;
  return c.json(rows);
});

router.post("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), citations: z.array(z.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  await (await getDb()).execute({
    sql: "INSERT INTO chat_messages (id, user_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
    args: [id, user.id, role, content, citations ? JSON.stringify(citations) : null],
  });
  return c.json({ id });
});

// ---- Email ----
router.get("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM email_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id],
  })).rows;
  return c.json(rows);
});

router.post("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z
    .array(
      z.object({
        lead_id: z.string(),
        subject: z.string(),
        body: z.string(),
        tone: z.string().optional(),
        goal: z.string().optional(),
        status: z.string().optional(),
        attachments: attachmentSchema,
      })
    )
    .parse(await c.req.json());
  const db = await getDb();
  // Only allow attaching to leads this user owns.
  const leadIds = Array.from(new Set(data.map((r) => r.lead_id)));
  const owned = await ownedLeadIds(db, user.id, leadIds);
  const items: { id: string; lead_id: string }[] = [];
  const statements: InStatement[] = [];
  for (const r of data) {
    if (!owned.has(r.lead_id)) continue;
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    statements.push({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null],
    });
  }
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  return c.json({ success: true, items });
});

router.post("/emails/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string(), sent_at: z.string().optional(), delivered_at: z.string().optional(), opened_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await userOwnsEmail(db, user.id, d.id))) return c.json({ error: "Email not found" }, 404);
  const sets = ["status = ?"]; const vals: (string | null)[] = [d.status];
  if (d.sent_at) { sets.push("sent_at = ?"); vals.push(d.sent_at); }
  if (d.delivered_at) { sets.push("delivered_at = ?"); vals.push(d.delivered_at); }
  if (d.opened_at) { sets.push("opened_at = ?"); vals.push(d.opened_at); }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});

// Actually send an email draft through Gmail SMTP (using this user's own
// Gmail credentials, set by an admin).
router.post("/emails/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id } = z.object({ id: z.string() }).parse(await c.req.json());
  const db = await getDb();
  const row = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0] as unknown as
    | { lead_id: string | null; subject: string; body: string; attachments: string | null }
    | undefined;
  if (!row) return c.json({ error: "Email not found" }, 404);
  if (!row.lead_id || !(await ownedLeadIds(db, user.id, [row.lead_id])).has(row.lead_id)) {
    return c.json({ error: "Email not found" }, 404);
  }
  const lead = (await db.execute({ sql: "SELECT email FROM leads WHERE id = ?", args: [row.lead_id] })).rows[0] as unknown as
    | { email: string | null }
    | undefined;
  if (!lead?.email) return c.json({ error: "Lead has no email address — add one before sending" }, 400);
  // Attachments stored on the row: JSON [{ filename, contentType, data(base64) }]
  // -> nodemailer attachment buffers.
  const attachments = parseAttachments(row.attachments).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.data, "base64"),
  }));
  try {
    const mailCfg = await userMailerConfig(db, user.id);
    const sent = await sendMessage({ to: lead.email, subject: row.subject, text: row.body, attachments }, mailCfg);
    const now = new Date().toISOString();
    await db.execute({
      sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
      args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id],
    });
    await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, row.lead_id] });
    await insertEvent(db, {
      lead_id: row.lead_id,
      channel: "email",
      type: "email",
      direction: "outbound",
      handled_by: "human",
      action: "sent",
      summary: row.subject,
      content: row.body,
      source_ref: id,
      metadata: { message_id: sent.message_id ?? null, thread_id: sent.thread_id ?? null, to: lead.email },
      created_at: now,
    });
    const updated = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
    return c.json(updated);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Pull the latest inbound mail from this user's own Gmail inbox into email_messages.
router.post("/emails/sync", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  let mailCfg: MailerConfig;
  try {
    mailCfg = await userMailerConfig(db, user.id);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  try {
    const result = await syncUserInbox(db, user.id, mailCfg);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// ---- WhatsApp ----
router.get("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id],
  })).rows;
  return c.json(rows);
});

router.post("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z
    .array(z.object({ lead_id: z.string(), body: z.string(), status: z.string().optional(), attachments: attachmentSchema }))
    .parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = new Date().toISOString();
  const items: { id: string; lead_id: string }[] = [];
  const statements: InStatement[] = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    return [
      { sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status, attachments) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.body, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "draft", r.body.slice(0, 120), id, now] },
    ];
  });
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  return c.json({ success: true, items });
});

router.post("/whatsapps/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string(), sent_at: z.string().optional(), delivered_at: z.string().optional(), read_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await userOwnsWhatsapp(db, user.id, d.id))) return c.json({ error: "WhatsApp message not found" }, 404);
  const sets = ["status = ?"]; const vals: (string | null)[] = [d.status];
  if (d.sent_at) { sets.push("sent_at = ?"); vals.push(d.sent_at); }
  if (d.delivered_at) { sets.push("delivered_at = ?"); vals.push(d.delivered_at); }
  if (d.read_at) { sets.push("read_at = ?"); vals.push(d.read_at); }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const w = (await db.execute({ sql: "SELECT lead_id FROM whatsapp_messages WHERE id = ?", args: [d.id] })).rows[0] as unknown as { lead_id: string | null } | undefined;
  await insertEvent(db, { lead_id: w?.lead_id ?? null, channel: "whatsapp", action: d.status, source_ref: d.id });
  return c.json({ success: true });
});// Actually send a WhatsApp message through the provider. Accepts an existing
// draft `id`, or a raw `{ lead_id, body }` (convenience for a single send).
// Text goes out first; any attachments are then sent as media via RelayX.
router.post("/whatsapps/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z
    .object({ id: z.string().optional(), lead_id: z.string().optional(), body: z.string().optional(), attachments: attachmentSchema })
    .parse(await c.req.json());
  const db = await getDb();

  let messageId = d.id ?? "";
  let leadId: string | null = d.lead_id ?? null;
  let body = d.body ?? "";
  let fromNumber: string | null = null;
  let attachments: { filename: string; contentType: string; data: string }[] = [];

  if (!messageId && (leadId && body)) {
    // One-off send: create the outbound row first.
    if (!(await ownedLeadIds(db, user.id, [leadId])).has(leadId)) return c.json({ error: "Lead not found" }, 404);
    const cfg = whatsappConfig();
    const newId = crypto.randomUUID();
    const lead = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0] as unknown as { phone: string | null } | undefined;
    if (!lead?.phone) return c.json({ error: "Lead has no phone number — add one before sending" }, 400);
    attachments = d.attachments ?? [];
    await db.execute({
      sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, from_number, to_number, status, attachments) VALUES (?, ?, ?, 'outbound', ?, ?, 'draft', ?)",
      args: [newId, leadId, body, cfg.fromNumber || null, lead.phone, attachments.length ? JSON.stringify(attachments) : null],
    });
    messageId = newId;
    fromNumber = cfg.fromNumber || null;
  } else if (messageId) {
    if (!(await userOwnsWhatsapp(db, user.id, messageId))) return c.json({ error: "WhatsApp message not found" }, 404);
    // Existing row — read it back for the lead + body + sending number + files.
    const row = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0] as unknown as
      | { lead_id: string | null; body: string; from_number: string | null; attachments: string | null }
      | undefined;
    if (!row) return c.json({ error: "WhatsApp message not found" }, 404);
    leadId = row.lead_id;
    body = row.body;
    fromNumber = row.from_number ?? whatsappConfig().fromNumber ?? null;
    attachments = parseAttachments(row.attachments);
  }

  if (!leadId) return c.json({ error: "Message is not linked to a lead" }, 400);
  if (!body) return c.json({ error: "Nothing to send — message body is empty" }, 400);

  const lead = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0] as unknown as { phone: string | null } | undefined;
  if (!lead?.phone) return c.json({ error: "Lead has no phone number — add one before sending" }, 400);

  let send: { ok: boolean; providerMessageId: string | null; error?: string };
  try {
    send = await sendText(lead.phone, body);
  } catch (e) {
    console.error("SEND TEXT THREW:", e);
    send = { ok: false, providerMessageId: null, error: (e as Error).message };
  }
  if (!send.ok) return c.json({ error: send.error ?? "WhatsApp send failed" }, 502);

  // Attachments: media send is best-effort — if the bridge lacks the endpoint
  // the text still went out, and the caller is told which files failed.
  const attachmentErrors: string[] = [];
  for (const a of attachments) {
    try {
      const media = await sendMedia(lead.phone, { base64: a.data, mimetype: a.contentType, filename: a.filename });
      if (!media.ok) attachmentErrors.push(`${a.filename}: ${media.error ?? "failed"}`);
    } catch (e) {
      attachmentErrors.push(`${a.filename}: ${(e as Error).message}`);
    }
  }

  const now = new Date().toISOString();
  await db.execute({
    sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ?, to_number = ?, from_number = ?, direction = 'outbound' WHERE id = ?",
    args: [now, send.providerMessageId, lead.phone, fromNumber, messageId],
  });
  await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, leadId] });
  await insertEvent(db, {
    lead_id: leadId,
    channel: "whatsapp",
    type: "whatsapp",
    direction: "outbound",
    handled_by: "human",
    action: "sent",
    summary: body.slice(0, 120),
    content: body,
    source_ref: messageId,
    metadata: { to: lead.phone, provider_message_id: send.providerMessageId, from: fromNumber, attachments: attachments.length },
    created_at: now,
  });
  const updated = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0];
  if (attachmentErrors.length) {
    return c.json({ ...(updated as object), warning: `Text sent, but ${attachmentErrors.length} attachment${attachmentErrors.length === 1 ? "" : "s"} failed: ${attachmentErrors.join("; ")}` });
  }
  return c.json(updated);

});

// ---- Calls ----
router.get("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id],
  })).rows;
  return c.json(rows);
});

router.post("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(z.object({ lead_id: z.string(), goal: z.string().optional(), voice: z.string().optional(), status: z.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = new Date().toISOString();
  const statements: InStatement[] = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    return [
      { sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "queued", r.goal ?? null, id, now] },
    ];
  });
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  const rows = (await db.execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id],
  })).rows;
  return c.json(rows);
});

router.post("/calls/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string().optional(), outcome: z.string().optional(), transcript: z.any().optional(), summary: z.string().optional(), duration_sec: z.number().optional(), started_at: z.string().optional(), ended_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await userOwnsCall(db, user.id, d.id))) return c.json({ error: "Call not found" }, 404);
  const sets: string[] = []; const vals: (string | number | null)[] = [];
  if (d.status !== undefined) { sets.push("status = ?"); vals.push(d.status); }
  if (d.outcome !== undefined) { sets.push("outcome = ?"); vals.push(d.outcome); }
  if (d.transcript !== undefined) { sets.push("transcript = ?"); vals.push(JSON.stringify(d.transcript)); }
  if (d.summary !== undefined) { sets.push("summary = ?"); vals.push(d.summary); }
  if (d.duration_sec !== undefined) { sets.push("duration_sec = ?"); vals.push(d.duration_sec); }
  if (d.started_at !== undefined) { sets.push("started_at = ?"); vals.push(d.started_at); }
  if (d.ended_at !== undefined) { sets.push("ended_at = ?"); vals.push(d.ended_at); }
  if (!sets.length) return c.json({ success: true });
  vals.push(d.id);
  await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const cl = (await db.execute({ sql: "SELECT lead_id FROM call_logs WHERE id = ?", args: [d.id] })).rows[0] as unknown as { lead_id: string | null } | undefined;
  await insertEvent(db, { lead_id: cl?.lead_id ?? null, channel: "call", action: d.outcome ?? d.status ?? "updated", source_ref: d.id });
  return c.json({ success: true });
});

// ---- Appointments ----
router.get("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT a.id, a.title, a.scheduled_at, a.lead_id FROM appointments a JOIN leads l ON l.id = a.lead_id
          WHERE l.user_id = ? ORDER BY a.scheduled_at ASC LIMIT 20`,
    args: [user.id],
  })).rows;
  return c.json(rows);
});

router.post("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ lead_id: z.string(), call_id: z.string().optional(), title: z.string(), scheduled_at: z.string(), duration_min: z.number().optional(), status: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await ownedLeadIds(db, user.id, [d.lead_id])).has(d.lead_id)) return c.json({ error: "Lead not found" }, 404);
  await db.execute({
    sql: "INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"],
  });
  return c.json({ success: true });
});

export default router;
