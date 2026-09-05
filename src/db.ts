import { createClient, type Client } from "@libsql/client";
import { slaDueAfter, computeSlaStatus } from "./lib/conversations";

let client: Client | undefined;
let initPromise: Promise<void> | undefined;

function getClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set. " +
          "Add them to your Vercel project environment variables (and locally) " +
          "to connect to the hosted Turso database."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}

// Idempotent schema — safe to run on every cold start.
const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    gmail_email TEXT,
    gmail_app_password TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    source TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','meeting','proposal','closed','lost')),
    score INTEGER DEFAULT 0,
    value REAL,
    city TEXT,
    notes TEXT,
    last_activity TEXT,
    interest TEXT,
    category TEXT,
    budget_min REAL,
    budget_max REAL,
    region TEXT,
    urgency TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS email_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    subject TEXT,
    body TEXT,
    tone TEXT,
    goal TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    opened_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    body TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    goal TEXT,
    voice TEXT,
    status TEXT DEFAULT 'pending',
    outcome TEXT,
    transcript TEXT,
    summary TEXT,
    duration_sec INTEGER DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    call_id TEXT,
    title TEXT,
    scheduled_at TEXT,
    duration_min INTEGER DEFAULT 30,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    citations TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','active','awaiting_reply','resolved','archived')),
    sla_due_at TEXT,
    sla_status TEXT NOT NULL DEFAULT 'none' CHECK(sla_status IN ('none','within_sla','breached')),
    first_event_at TEXT,
    last_event_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE (lead_id),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    conversation_id TEXT,
    lead_id TEXT,
    type TEXT,
    channel TEXT NOT NULL,
    direction TEXT NOT NULL DEFAULT 'internal',
    content TEXT,
    handled_by TEXT NOT NULL DEFAULT 'unhandled',
    status TEXT,
    action TEXT NOT NULL,
    summary TEXT,
    source_ref TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(channel, source_ref) WHERE source_ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`,
];

// Column migrations for tables created before these columns existed.
// ALTER TABLE fails with "duplicate column name" once applied, so each
// statement is attempted and the error is swallowed — idempotent across cold starts.
const EMAIL_MESSAGE_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE email_messages ADD COLUMN from_email TEXT`,
  `ALTER TABLE email_messages ADD COLUMN to_email TEXT`,
  // Column names kept from the original AgentMail integration (now Gmail
  // SMTP/IMAP, see lib/mailer.ts) to avoid a data migration — they hold the
  // provider message/thread id regardless of which mail provider wrote them.
  `ALTER TABLE email_messages ADD COLUMN agentmail_message_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN agentmail_thread_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN labels TEXT`,
];

// Phase 2 — WhatsApp: direction, participant numbers, provider dedupe id, and
// the timestamp we auto-acknowledged an off-hours inbound message (if any).
const WHATSAPP_MESSAGE_MIGRATIONS = [
  `ALTER TABLE whatsapp_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE whatsapp_messages ADD COLUMN from_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN to_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN provider_message_id TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN acknowledged_at TEXT`,
];

// Phase 3 — file attachments (JSON array of { filename, contentType, data(base64) })
// on outbound email + WhatsApp messages. Sent through Gmail SMTP / RelayX media.
const ATTACHMENT_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN attachments TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN attachments TEXT`,
];

// Admin panel — user access control (is_admin/disabled) for pre-existing DBs.
const USER_ACCESS_MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`,
];

// Multi-tenancy — each user only sees their own leads (and, transitively,
// their own emails/whatsapp/calls/conversations/events, all keyed off
// leads.user_id). chat_messages is scoped directly since it has no lead.
// Per-user Gmail sending credentials, set by an admin (falls back to the
// GMAIL_USER/GMAIL_APP_PASSWORD env vars when unset, e.g. for the demo user).
const TENANCY_MIGRATIONS = [
  `ALTER TABLE leads ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE chat_messages ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE users ADD COLUMN gmail_email TEXT`,
  `ALTER TABLE users ADD COLUMN gmail_app_password TEXT`,
];

// Hardcoded demo account so login works out of the box.
//   email:    testuser@gmail.com
//   password: Str0ng!P9a  (10 chars: upper + lower + digit + symbol)
// INSERT OR IGNORE keeps the seed idempotent across restarts/cold starts.
const DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";

async function initDb(c: Client) {
  // Single round-trip: all DDL + demo-user seed run atomically on cold start.
  // Explicit id=1 for the demo user avoids AUTOINCREMENT sequence drift from
  // repeated INSERT OR IGNORE on every cold start.
  await c.batch(
    [
      ...TABLE_DDL,
      {
        sql: "INSERT OR IGNORE INTO users (id, name, email, password_hash) VALUES (1, ?, ?, ?)",
        args: ["Test User", "testuser@gmail.com", DEMO_USER_HASH],
      },
    ],
    "write"
  );

  // Column migrations run individually — ALTER TABLE cannot be batched with
  // a guaranteed outcome, and duplicate-column errors are expected once applied.
  for (const sql of [...EMAIL_MESSAGE_MIGRATIONS, ...WHATSAPP_MESSAGE_MIGRATIONS, ...ATTACHMENT_MIGRATIONS, ...USER_ACCESS_MIGRATIONS, ...TENANCY_MIGRATIONS]) {
    try {
      await c.execute(sql);
    } catch {
      // column already exists — ignore
    }
  }

  // Make the demo/first user an admin so the admin panel is reachable out of the box.
  await c.execute(`UPDATE users SET is_admin = 1 WHERE id = 1`);

  // Backfill: any lead/chat_message created before per-user ownership existed
  // (user_id IS NULL) is assigned to the demo/first user so existing data
  // isn't orphaned or invisible after this migration.
  await c.execute(`UPDATE leads SET user_id = 1 WHERE user_id IS NULL`);
  await c.execute(`UPDATE chat_messages SET user_id = 1 WHERE user_id IS NULL`);

  // Backfill events from pre-existing channel rows so the activity feed has
  // history. Idempotent: INSERT OR IGNORE + unique (channel, source_ref).
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'email',
           CASE WHEN direction = 'inbound' THEN 'received' ELSE COALESCE(status, 'sent') END,
           subject, id, created_at
    FROM email_messages
  `);
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'whatsapp',
           CASE WHEN direction = 'inbound' THEN 'received' ELSE COALESCE(status, 'sent') END,
           body, id, created_at
    FROM whatsapp_messages
  `);
  await c.execute(`
    INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at)
    SELECT 'evt-' || id, lead_id, 'call', COALESCE(status, 'pending'), goal, id, created_at
    FROM call_logs
  `);

  // Generic pipeline: ensure the leads schema matches the pipeline stages
  // (new → contacted → qualified → meeting → proposal → closed → lost) and the
  // generic columns. SQLite cannot ALTER a CHECK constraint, so this rebuilds
  // the table exactly once; legacy statuses map to their new equivalents.
  await migrateLeadsToGenericPipeline(c);

  // Phase 0 — unify onto the Conversation/Event model (idempotent).
  await migrateEventsToConversations(c);
}

/**
 * Guarded one-time rebuild of `leads` onto the generic pipeline schema:
 *   - stages: new / contacted / qualified / meeting / proposal / closed / lost
 *   - columns: interest, category, budget_min, budget_max, region, urgency
 * Legacy rows are mapped ('booked'/'viewing' → 'meeting', 'offer' → 'proposal')
 * and older real-estate column names (property_interest / property_type / area)
 * are carried over into interest / category / region when present, so no data
 * is lost. Idempotent: skipped once the `interest` column already exists.
 */
async function migrateLeadsToGenericPipeline(c: Client) {
  const cols = ((await c.execute(`SELECT name FROM pragma_table_info('leads')`)).rows as unknown as { name: string }[]).map(
    (r) => r.name,
  );
  if (cols.includes("interest")) return; // already on the generic schema
  const has = (name: string) => cols.includes(name);
  const selectOr = (legacy: string) => (has(legacy) ? legacy : "NULL");
  await c.batch(
    [
      `CREATE TABLE leads_generic (
        id TEXT PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        company TEXT,
        source TEXT,
        status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','meeting','proposal','closed','lost')),
        score INTEGER DEFAULT 0,
        value REAL,
        city TEXT,
        notes TEXT,
        last_activity TEXT,
        interest TEXT,
        category TEXT,
        budget_min REAL,
        budget_max REAL,
        region TEXT,
        urgency TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `INSERT INTO leads_generic (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at, interest, category, budget_min, budget_max, region, urgency)
         SELECT id,
                ${has("user_id") ? "user_id" : "NULL"},
                name, email, phone, company, source,
                CASE WHEN status IN ('booked','viewing') THEN 'meeting' WHEN status = 'offer' THEN 'proposal' ELSE status END,
                score, value, city, notes, last_activity, created_at,
                ${selectOr("property_interest")},
                ${selectOr("property_type")},
                ${selectOr("budget_min")},
                ${selectOr("budget_max")},
                ${selectOr("area")},
                ${selectOr("urgency")}
         FROM leads`,
      `DROP TABLE leads`,
      `ALTER TABLE leads_generic RENAME TO leads`,
      `CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)`,
      `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`,
    ],
    "write"
  );
}

/**
 * Build the Phase 0 foundation:
 *   1. Rebuild `events` onto the channel-agnostic schema (one-time, guarded).
 *   2. Ensure every lead has exactly one conversation.
 *   3. Link all existing events into their conversation.
 *   4. Infer type / direction / handled_by / content for legacy rows.
 *   5. Recompute conversation timeline + SLA.
 */
async function migrateEventsToConversations(c: Client) {
  // Guard: skip the rebuild if the unified columns already exist.
  if (!(await tableHasColumn(c, "events", "conversation_id"))) {
    await c.batch(
      [
        `CREATE TABLE events_foundation (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          lead_id TEXT,
          type TEXT,
          channel TEXT NOT NULL,
          direction TEXT NOT NULL DEFAULT 'internal',
          content TEXT,
          handled_by TEXT NOT NULL DEFAULT 'unhandled',
          status TEXT,
          action TEXT NOT NULL,
          summary TEXT,
          source_ref TEXT,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        )`,
        `INSERT INTO events_foundation (id, lead_id, channel, action, summary, source_ref, metadata, created_at)
           SELECT id, lead_id, channel, action, summary, source_ref, metadata, created_at FROM events`,
        `DROP TABLE events`,
        `ALTER TABLE events_foundation RENAME TO events`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(channel, source_ref) WHERE source_ref IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`,
        `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`,
      ],
      "write"
    );
  }

  // These indexes need the unified columns, so they're created here — after the
  // rebuild — on both fresh and migrated databases.
  await c.batch(
    [
      `CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`,
    ],
    "write"
  );

  // One conversation per contact.
  await c.execute(`
    INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
    SELECT 'conv-' || id, id, 'new', 'none', datetime('now') FROM leads
  `);

  // Link events to their conversation.
  await c.execute(`
    UPDATE events SET conversation_id = 'conv-' || lead_id
    WHERE conversation_id IS NULL AND lead_id IS NOT NULL
  `);

  // Infer type + content for legacy rows.
  await c.execute(`
    UPDATE events SET type = COALESCE(type, channel), content = COALESCE(content, summary)
    WHERE type IS NULL OR content IS NULL
  `);

  // Infer direction + handled_by for legacy backfilled channel rows only
  // (real events already carry these explicitly).
  await c.execute(`
    UPDATE events SET
      direction = CASE
        WHEN COALESCE(action,'') IN ('received','inbound','auto-acknowledged') THEN 'inbound'
        WHEN channel = 'call' THEN 'outbound' ELSE 'outbound' END,
      handled_by = CASE WHEN channel = 'call' THEN 'ai'
        WHEN COALESCE(action,'') IN ('received','inbound','auto-acknowledged') THEN 'unhandled'
        ELSE 'human' END
    WHERE direction = 'internal' AND channel IN ('email','whatsapp','call') AND source_ref IS NOT NULL
  `);

  // Recompute conversation timeline.
  await c.execute(`
    UPDATE conversations SET
      first_event_at = (SELECT MIN(created_at) FROM events WHERE conversation_id = conversations.id),
      last_event_at  = (SELECT MAX(created_at) FROM events WHERE conversation_id = conversations.id)
  `);

  // Recompute the SLA timer: earliest inbound-unhandled event + SLA window.
  const rows = (await c.execute(`
    SELECT conversation_id, MIN(created_at) AS due0, MAX(created_at) AS last0
    FROM events
    WHERE direction = 'inbound' AND handled_by = 'unhandled' AND conversation_id IS NOT NULL
    GROUP BY conversation_id
  `)).rows as unknown as { conversation_id: string; due0: string; last0: string }[];
  for (const r of rows) {
    const due = slaDueAfter(r.due0);
    await c.execute({
      sql: `UPDATE conversations SET sla_due_at = ?, sla_status = ?,
            status = CASE WHEN status IN ('new','active') THEN 'awaiting_reply' ELSE status END
            WHERE id = ? AND (sla_due_at IS NULL OR ? < sla_due_at)`,
      args: [due, computeSlaStatus(due), r.conversation_id, due],
    });
  }
}

async function tableHasColumn(c: Client, table: string, column: string): Promise<boolean> {
  const r = await c.execute(`SELECT name FROM pragma_table_info('${table}') WHERE name = '${column}' LIMIT 1`);
  return r.rows.length > 0;
}

/**
 * Returns the Turso client, ensuring the schema + demo user exist on first use.
 * Lazily initialized so serverless cold starts stay fast.
 */
export async function getDb(): Promise<Client> {
  const c = getClient();
  if (!initPromise) {
    initPromise = initDb(c).catch((err) => {
      initPromise = undefined; // allow retry on next call
      throw err;
    });
  }
  await initPromise;
  return c;
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
