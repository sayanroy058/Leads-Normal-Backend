// Gmail SMTP + IMAP mail client — replaces the earlier AgentMail integration.
//
// Sending: nodemailer over Gmail SMTP, authenticated with a Gmail App
// Password (NOT the account password — Gmail requires 2FA + an app-specific
// password for SMTP/IMAP basic auth: https://support.google.com/mail/answer/185833).
//
// Receiving: IMAP (imapflow) against Gmail's IMAP server, since Gmail has no
// lighter REST endpoint for reading mail without full OAuth setup — an app
// password only grants IMAP/SMTP basic auth, not the Gmail REST API.
//
// The exported functions mirror the old lib/agentmail.ts shape
// (sendMessage / listMessages / getMessage) so routes/messages.ts needed
// only minimal changes to switch providers.
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface MailerConfig {
  user: string;
  appPassword: string;
  imapHost: string;
  smtpHost: string;
}

/** Falls back to the global GMAIL_USER/GMAIL_APP_PASSWORD env vars — used only
 * when no per-user config is supplied (e.g. scripts, or before multi-tenant
 * routing was added). Routes should pass each user's own config instead. */
export function mailerConfig(): MailerConfig {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com",
  };
}

// One transporter per Gmail account (multi-tenant — each user sends from
// their own inbox), keyed by address. Small map, never evicted; the process
// only lives for the duration of a serverless invocation anyway.
const transporters = new Map<string, ReturnType<typeof nodemailer.createTransport>>();
function getTransporter(cfg: MailerConfig) {
  let t = transporters.get(cfg.user);
  if (!t) {
    t = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.appPassword },
    });
    transporters.set(cfg.user, t);
  }
  return t;
}

export interface SentMessage {
  message_id: string | null;
  thread_id: string | null;
}

/** One file attached to an outbound email (nodemailer attachment shape). */
export interface MailAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

/** Send an email from the given (or global default) Gmail account. */
export async function sendMessage(
  args: {
    to: string;
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  },
  cfg: MailerConfig = mailerConfig()
): Promise<SentMessage> {
  const info = await getTransporter(cfg).sendMail({
    from: cfg.user,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...(args.html ? { html: args.html } : {}),
    ...(args.attachments && args.attachments.length ? { attachments: args.attachments } : {}),
  });
  // Gmail SMTP doesn't return a thread id at send time (that's an IMAP/Gmail
  // API concept) — messageId is what we have to key off for dedupe on sync.
  return { message_id: info.messageId ?? null, thread_id: null };
}

export interface FetchedMessage {
  message_id: string;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  extracted_text: string | null;
  extracted_html: string | null;
  timestamp: string | null;
  labels: string[];
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>, cfg: MailerConfig = mailerConfig()): Promise<T> {
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.appPassword },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * List the most recent messages across INBOX and Sent (newest first) using
 * only the IMAP envelope — no body download, no mailparser pass. This is
 * what makes listing cheap: envelope is metadata the server already has
 * indexed, versus `source` which downloads and parses the full raw message.
 * Callers that need the body (sync, for messages not yet stored) should
 * fetch it separately via getMessage() for just that one message.
 */
export async function listMessages(
  args: { limit?: number } = {},
  cfg: MailerConfig = mailerConfig()
): Promise<{ messages: FetchedMessage[] }> {
  const limit = args.limit ?? 50;
  const messages = await withImap(async (client) => {
    const out: FetchedMessage[] = [];
    for (const mailbox of ["INBOX", "[Gmail]/Sent Mail"]) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        continue; // mailbox name varies by locale/account — skip if missing
      }
      try {
        const box = client.mailbox;
        if (!box || typeof box === "boolean") continue;
        const total = box.exists;
        if (!total) continue;
        const from = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, uid: true })) {
          out.push(toEnvelopeMessage(msg.envelope, msg.uid, mailbox, cfg.user));
        }
      } finally {
        lock.release();
      }
    }
    out.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return out.slice(0, limit);
  }, cfg);
  return { messages };
}

/** Fetch one full message by its message_id (as returned from listMessages). */
export async function getMessage(messageId: string, cfg: MailerConfig = mailerConfig()): Promise<FetchedMessage> {
  // messageId is "account:mailbox:uid" (see toFetchedMessage) — account is
  // included so ids are unique across different users' Gmail accounts, but
  // isn't needed to locate the message since cfg already picks the account.
  const parts = messageId.split(":");
  const [mailbox, uidStr] = parts.length >= 3 ? parts.slice(1) : parts;
  const uid = Number(uidStr);
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      for await (const msg of client.fetch({ uid }, { source: true, uid: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        return toFetchedMessage(parsed, msg.uid, mailbox, cfg.user);
      }
      throw new Error(`Message ${messageId} not found`);
    } finally {
      lock.release();
    }
  }, cfg);
}

/** Build a listing-only FetchedMessage straight from the IMAP envelope — no
 * body fields (text/html/extracted_*) since those require a full fetch. */
function toEnvelopeMessage(envelope: import("imapflow").MessageEnvelopeObject | undefined, uid: number, mailbox: string, account: string): FetchedMessage {
  const isSent = mailbox.toLowerCase().includes("sent");
  const addr = (list?: { name?: string; address?: string }[]) =>
    list && list.length ? list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ") : null;
  return {
    message_id: `${account}:${mailbox}:${uid}`,
    thread_id: null,
    from: addr(envelope?.from),
    to: addr(envelope?.to),
    subject: envelope?.subject ?? null,
    text: null,
    html: null,
    extracted_text: null,
    extracted_html: null,
    timestamp: envelope?.date ? envelope.date.toISOString() : null,
    labels: isSent ? ["sent"] : [],
  };
}

function toFetchedMessage(parsed: Awaited<ReturnType<typeof simpleParser>>, uid: number, mailbox: string, account: string): FetchedMessage {
  const isSent = mailbox.toLowerCase().includes("sent");
  return {
    // Prefixed with the account so the same IMAP uid in two different users'
    // mailboxes (both commonly start counting from 1) never collides in the
    // agentmail_message_id dedupe check on sync.
    message_id: `${account}:${mailbox}:${uid}`,
    thread_id: (parsed.headers.get("thread-index") as string | undefined) ?? null,
    from: parsed.from?.text ?? null,
    to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : (parsed.to?.text ?? null),
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    extracted_text: parsed.text ?? null,
    extracted_html: typeof parsed.html === "string" ? parsed.html : null,
    timestamp: parsed.date ? parsed.date.toISOString() : null,
    labels: isSent ? ["sent"] : [],
  };
}
