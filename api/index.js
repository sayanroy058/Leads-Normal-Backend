// src/index.ts
import { serve } from "@hono/node-server";
import { Hono as Hono8 } from "hono";
import { cors } from "hono/cors";

// src/routes/auth.ts
import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { verify as argon2Verify } from "@node-rs/argon2";

// src/db.ts
import { createClient } from "@libsql/client";

// src/lib/conversations.ts
var SLA_RESPONSE_HOURS = (() => {
  const v = Number(process.env.SLA_RESPONSE_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 4;
})();
function slaDueAfter(from) {
  const d = new Date(from);
  d.setTime(d.getTime() + SLA_RESPONSE_HOURS * 3600 * 1e3);
  return d.toISOString();
}
function computeSlaStatus(dueAt, now = /* @__PURE__ */ new Date()) {
  if (!dueAt) return "none";
  return new Date(dueAt).getTime() < now.getTime() ? "breached" : "within_sla";
}
async function getOrCreateConversation(db, leadId) {
  const id = `conv-${leadId}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
          VALUES (?, ?, 'new', 'none', ?)`,
    args: [id, leadId, (/* @__PURE__ */ new Date()).toISOString()]
  });
  const row = (await db.execute({ sql: "SELECT * FROM conversations WHERE id = ?", args: [id] })).rows[0];
  if (!row) throw new Error("Failed to load conversation");
  row.sla_due_at = row.sla_due_at ?? null;
  row.sla_status = computeSlaStatus(row.sla_due_at);
  return row;
}
async function touchConversation(db, ev) {
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const conv = (await db.execute({ sql: "SELECT status, sla_due_at FROM conversations WHERE id = ?", args: [ev.conversation_id] })).rows[0];
  if (!conv) return;
  let dueAt = conv.sla_due_at;
  let status = conv.status;
  const inbound = ev.direction === "inbound";
  const isReply = ev.direction === "outbound" || (ev.handledBy === "human" || ev.handledBy === "ai") && ev.direction !== "internal";
  if (inbound && ev.handledBy === "unhandled") {
    const due = slaDueAfter(ev.createdAt);
    if (!dueAt || new Date(due).getTime() < new Date(dueAt).getTime()) dueAt = due;
    if (status !== "resolved" && status !== "archived") status = "awaiting_reply";
  } else if (isReply) {
    dueAt = null;
    if (status === "awaiting_reply") status = "active";
  }
  await db.execute({
    sql: `UPDATE conversations SET
      first_event_at = COALESCE(first_event_at, ?),
      last_event_at = CASE WHEN last_event_at IS NULL OR ? > last_event_at THEN ? ELSE last_event_at END,
      sla_due_at = ?, sla_status = ?, status = ?, updated_at = ?
      WHERE id = ?`,
    args: [ev.createdAt, ev.createdAt, ev.createdAt, dueAt, computeSlaStatus(dueAt), status, nowIso, ev.conversation_id]
  });
}
async function setConversationStatus(db, conversationId, status) {
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "UPDATE conversations SET status = ?, sla_due_at = NULL, sla_status = 'none', updated_at = ? WHERE id = ?",
    args: [status, nowIso, conversationId]
  });
}

// src/db.ts
var client;
var initPromise;
function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set. Add them to your Vercel project environment variables (and locally) to connect to the hosted Turso database."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}
var TABLE_DDL = [
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
  `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`
];
var EMAIL_MESSAGE_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE email_messages ADD COLUMN from_email TEXT`,
  `ALTER TABLE email_messages ADD COLUMN to_email TEXT`,
  // Column names kept from the original AgentMail integration (now Gmail
  // SMTP/IMAP, see lib/mailer.ts) to avoid a data migration — they hold the
  // provider message/thread id regardless of which mail provider wrote them.
  `ALTER TABLE email_messages ADD COLUMN agentmail_message_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN agentmail_thread_id TEXT`,
  `ALTER TABLE email_messages ADD COLUMN labels TEXT`
];
var WHATSAPP_MESSAGE_MIGRATIONS = [
  `ALTER TABLE whatsapp_messages ADD COLUMN direction TEXT DEFAULT 'outbound'`,
  `ALTER TABLE whatsapp_messages ADD COLUMN from_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN to_number TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN provider_message_id TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN acknowledged_at TEXT`
];
var ATTACHMENT_MIGRATIONS = [
  `ALTER TABLE email_messages ADD COLUMN attachments TEXT`,
  `ALTER TABLE whatsapp_messages ADD COLUMN attachments TEXT`
];
var USER_ACCESS_MIGRATIONS = [
  `ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0`
];
var TENANCY_MIGRATIONS = [
  `ALTER TABLE leads ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE chat_messages ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE`,
  `ALTER TABLE users ADD COLUMN gmail_email TEXT`,
  `ALTER TABLE users ADD COLUMN gmail_app_password TEXT`
];
var DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
async function initDb(c) {
  await c.batch(
    [
      ...TABLE_DDL,
      {
        sql: "INSERT OR IGNORE INTO users (id, name, email, password_hash) VALUES (1, ?, ?, ?)",
        args: ["Test User", "testuser@gmail.com", DEMO_USER_HASH]
      }
    ],
    "write"
  );
  for (const sql of [...EMAIL_MESSAGE_MIGRATIONS, ...WHATSAPP_MESSAGE_MIGRATIONS, ...ATTACHMENT_MIGRATIONS, ...USER_ACCESS_MIGRATIONS, ...TENANCY_MIGRATIONS]) {
    try {
      await c.execute(sql);
    } catch {
    }
  }
  await c.execute(`UPDATE users SET is_admin = 1 WHERE id = 1`);
  await c.execute(`UPDATE leads SET user_id = 1 WHERE user_id IS NULL`);
  await c.execute(`UPDATE chat_messages SET user_id = 1 WHERE user_id IS NULL`);
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
  await migrateLeadsToGenericPipeline(c);
  await migrateEventsToConversations(c);
}
async function migrateLeadsToGenericPipeline(c) {
  const cols = (await c.execute(`SELECT name FROM pragma_table_info('leads')`)).rows.map(
    (r) => r.name
  );
  if (cols.includes("interest")) return;
  const has = (name) => cols.includes(name);
  const selectOr = (legacy) => has(legacy) ? legacy : "NULL";
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
      `CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone)`
    ],
    "write"
  );
}
async function migrateEventsToConversations(c) {
  if (!await tableHasColumn(c, "events", "conversation_id")) {
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
        `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`
      ],
      "write"
    );
  }
  await c.batch(
    [
      `CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id)`,
      `CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id)`
    ],
    "write"
  );
  await c.execute(`
    INSERT OR IGNORE INTO conversations (id, lead_id, status, sla_status, created_at)
    SELECT 'conv-' || id, id, 'new', 'none', datetime('now') FROM leads
  `);
  await c.execute(`
    UPDATE events SET conversation_id = 'conv-' || lead_id
    WHERE conversation_id IS NULL AND lead_id IS NOT NULL
  `);
  await c.execute(`
    UPDATE events SET type = COALESCE(type, channel), content = COALESCE(content, summary)
    WHERE type IS NULL OR content IS NULL
  `);
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
  await c.execute(`
    UPDATE conversations SET
      first_event_at = (SELECT MIN(created_at) FROM events WHERE conversation_id = conversations.id),
      last_event_at  = (SELECT MAX(created_at) FROM events WHERE conversation_id = conversations.id)
  `);
  const rows = (await c.execute(`
    SELECT conversation_id, MIN(created_at) AS due0, MAX(created_at) AS last0
    FROM events
    WHERE direction = 'inbound' AND handled_by = 'unhandled' AND conversation_id IS NOT NULL
    GROUP BY conversation_id
  `)).rows;
  for (const r of rows) {
    const due = slaDueAfter(r.due0);
    await c.execute({
      sql: `UPDATE conversations SET sla_due_at = ?, sla_status = ?,
            status = CASE WHEN status IN ('new','active') THEN 'awaiting_reply' ELSE status END
            WHERE id = ? AND (sla_due_at IS NULL OR ? < sla_due_at)`,
      args: [due, computeSlaStatus(due), r.conversation_id, due]
    });
  }
}
async function tableHasColumn(c, table, column) {
  const r = await c.execute(`SELECT name FROM pragma_table_info('${table}') WHERE name = '${column}' LIMIT 1`);
  return r.rows.length > 0;
}
async function getDb() {
  const c = getClient();
  if (!initPromise) {
    initPromise = initDb(c).catch((err) => {
      initPromise = void 0;
      throw err;
    });
  }
  await initPromise;
  return c;
}
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/middleware/auth.ts
async function authenticate(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.name, u.email, u.is_admin, u.disabled FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    args: [token]
  });
  const row = result.rows[0];
  if (!row) return null;
  if (row.disabled) return null;
  return { id: row.id, name: row.name, email: row.email, is_admin: !!row.is_admin };
}
async function authenticateAdmin(c) {
  const user = await authenticate(c);
  if (!user || !user.is_admin) return null;
  return user;
}

// src/routes/auth.ts
var router = new Hono();
var registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
});
var loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
async function verifyPassword(db, password, storedHash, userId) {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      await db.execute({
        sql: "UPDATE users SET password_hash = ? WHERE id = ?",
        args: [newHash, userId]
      });
    }
    return ok;
  }
  return bcrypt.compare(password, storedHash);
}
router.post("/register", async (c) => {
  try {
    const data = registerSchema.parse(await c.req.json());
    const db = await getDb();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [data.email.toLowerCase().trim()] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      args: [data.name.trim() || null, data.email.toLowerCase().trim(), hash]
    });
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, userId] });
    const user = (await db.execute({ sql: "SELECT id, name, email, is_admin FROM users WHERE id = ?", args: [userId] })).rows[0];
    return c.json({ token, user: { ...user, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db = await getDb();
    const user = (await db.execute({
      sql: "SELECT id, name, email, password_hash, is_admin, disabled FROM users WHERE email = ?",
      args: [data.email.toLowerCase().trim()]
    })).rows[0];
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    if (user.disabled) return c.json({ error: "This account has been disabled. Contact your administrator." }, 403);
    const valid = await verifyPassword(db, data.password, user.password_hash, user.id);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, user.id] });
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email, is_admin: !!user.is_admin } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/logout", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization");
  const token = authHeader.slice(7);
  await (await getDb()).execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [token] });
  return c.json({ success: true });
});
router.get("/me", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user });
});
var auth_default = router;

// src/routes/leads.ts
import { Hono as Hono2 } from "hono";
import { z as z2 } from "zod";
var router2 = new Hono2();
router2.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE user_id = ? ORDER BY created_at DESC", args: [user.id] })).rows;
  return c.json(rows);
});
var LEAD_STATUSES = ["new", "contacted", "qualified", "meeting", "proposal", "closed", "lost"];
var leadSchema = z2.object({
  name: z2.string(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(LEAD_STATUSES).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional(),
  // Lead detail fields
  interest: z2.string().nullable().optional(),
  category: z2.string().nullable().optional(),
  budget_min: z2.number().nullable().optional(),
  budget_max: z2.number().nullable().optional(),
  region: z2.string().nullable().optional(),
  urgency: z2.string().nullable().optional()
});
var updateLeadSchema = z2.object({
  name: z2.string().optional(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(LEAD_STATUSES).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional(),
  // Lead detail fields
  interest: z2.string().nullable().optional(),
  category: z2.string().nullable().optional(),
  budget_min: z2.number().nullable().optional(),
  budget_max: z2.number().nullable().optional(),
  region: z2.string().nullable().optional(),
  urgency: z2.string().nullable().optional()
});
var SCORE_FIELDS = [
  "email",
  "phone",
  "company",
  "city",
  "notes",
  "value",
  "interest",
  "category",
  "region",
  "urgency"
];
function computeLeadScore(r) {
  let present = 0;
  for (const f of SCORE_FIELDS) {
    const v = r[f];
    if (v !== void 0 && v !== null && String(v).trim() !== "") present++;
  }
  return Math.round(present / SCORE_FIELDS.length * 100);
}
router2.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z2.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted = [];
  const statements = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    statements.push({
      sql: "INSERT OR REPLACE INTO leads (id, user_id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at, interest, category, budget_min, budget_max, region, urgency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, user.id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", computeLeadScore(r), r.value ?? null, r.city ?? null, r.notes ?? null, now, now, r.interest ?? null, r.category ?? null, r.budget_min ?? null, r.budget_max ?? null, r.region ?? null, r.urgency ?? null]
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: computeLeadScore(r), last_activity: now, created_at: now });
  }
  if (statements.length) await db.batch(statements, "write");
  return c.json(inserted);
});
router2.post("/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z2.object({ id: z2.string(), status: z2.enum(LEAD_STATUSES) }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "UPDATE leads SET status = ?, last_activity = ? WHERE id = ? AND user_id = ?",
    args: [status, (/* @__PURE__ */ new Date()).toISOString(), id, user.id]
  });
  return c.json({ success: true });
});
router2.get("/activity/counts", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT
      (SELECT COUNT(*) FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS emails,
      (SELECT COUNT(*) FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS whatsapps,
      (SELECT COUNT(*) FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS calls,
      (SELECT COUNT(*) FROM appointments m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ?) AS appts`,
    args: [user.id, user.id, user.id, user.id]
  })).rows;
  const row = rows[0];
  return c.json({ emails: row.emails, whatsapps: row.whatsapps, calls: row.calls, appts: row.appts });
});
router2.get("/activity/feed", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const rows = (await db.execute({
    sql: `SELECT e.id, e.type, e.channel, e.direction, e.action, e.summary, e.content, e.created_at
          FROM events e JOIN leads l ON l.id = e.lead_id
          WHERE e.channel IN ('email','whatsapp','call') AND l.user_id = ?
          ORDER BY e.created_at DESC LIMIT 20`,
    args: [user.id]
  })).rows;
  const items = rows.map((e) => {
    const dir = e.direction === "inbound" ? "inbound" : "outbound";
    const body = e.content ?? e.summary ?? "";
    return {
      id: e.id,
      type: e.type ?? e.channel,
      text: e.channel === "email" ? `${dir === "inbound" ? "Inbound" : "Sent"} email \u2014 ${e.action}: "${e.summary ?? ""}"` : e.channel === "whatsapp" ? `${dir === "inbound" ? "Inbound WhatsApp" : "Outbound WhatsApp"} \u2014 ${body.slice(0, 80)}` : `Call \u2014 ${e.action}${e.summary ? `: ${e.summary}` : ""}`,
      when: e.created_at
    };
  });
  return c.json(items.slice(0, 8));
});
router2.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const row = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [c.req.param("id"), user.id] })).rows[0];
  if (!row) return c.json({ error: "Lead not found" }, 404);
  return c.json(row);
});
router2.put("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const data = updateLeadSchema.parse(await c.req.json());
  const db = await getDb();
  const existing = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] })).rows[0];
  if (!existing) return c.json({ error: "Lead not found" }, 404);
  const score = computeLeadScore({ ...existing, ...data });
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "score") continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("score = ?");
  vals.push(score);
  sets.push("last_activity = ?");
  vals.push((/* @__PURE__ */ new Date()).toISOString());
  vals.push(id, user.id);
  await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  return c.json(row);
});
router2.delete("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  await (await getDb()).execute({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] });
  return c.json({ success: true });
});
router2.post("/bulk-delete", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { ids } = z2.object({ ids: z2.array(z2.string()).min(1) }).parse(await c.req.json());
  const db = await getDb();
  const statements = ids.map((id) => ({ sql: "DELETE FROM leads WHERE id = ? AND user_id = ?", args: [id, user.id] }));
  await db.batch(statements, "write");
  return c.json({ success: true, deleted: ids.length });
});
var leads_default = router2;

// src/routes/messages.ts
import { Hono as Hono3 } from "hono";
import { z as z3 } from "zod";

// src/lib/mailer.ts
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
function mailerConfig() {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var transporters = /* @__PURE__ */ new Map();
function getTransporter(cfg) {
  let t = transporters.get(cfg.user);
  if (!t) {
    t = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: 465,
      secure: true,
      auth: { user: cfg.user, pass: cfg.appPassword }
    });
    transporters.set(cfg.user, t);
  }
  return t;
}
async function sendMessage(args, cfg = mailerConfig()) {
  const info = await getTransporter(cfg).sendMail({
    from: cfg.user,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...args.html ? { html: args.html } : {},
    ...args.attachments && args.attachments.length ? { attachments: args.attachments } : {}
  });
  return { message_id: info.messageId ?? null, thread_id: null };
}
async function withImap(fn, cfg = mailerConfig()) {
  const client2 = new ImapFlow({
    host: cfg.imapHost,
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.appPassword },
    logger: false
  });
  await client2.connect();
  try {
    return await fn(client2);
  } finally {
    await client2.logout().catch(() => client2.close());
  }
}
async function listMessages(args = {}, cfg = mailerConfig()) {
  const limit = args.limit ?? 50;
  const messages = await withImap(async (client2) => {
    const out = [];
    for (const mailbox of ["INBOX", "[Gmail]/Sent Mail"]) {
      let lock;
      try {
        lock = await client2.getMailboxLock(mailbox);
      } catch {
        continue;
      }
      try {
        const box = client2.mailbox;
        if (!box || typeof box === "boolean") continue;
        const total = box.exists;
        if (!total) continue;
        const from = Math.max(1, total - limit + 1);
        for await (const msg of client2.fetch(`${from}:${total}`, { envelope: true, uid: true })) {
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
async function getMessage(messageId, cfg = mailerConfig()) {
  const parts = messageId.split(":");
  const [mailbox, uidStr] = parts.length >= 3 ? parts.slice(1) : parts;
  const uid = Number(uidStr);
  return withImap(async (client2) => {
    const lock = await client2.getMailboxLock(mailbox);
    try {
      for await (const msg of client2.fetch({ uid }, { source: true, uid: true }, { uid: true })) {
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
function toEnvelopeMessage(envelope, uid, mailbox, account) {
  const isSent = mailbox.toLowerCase().includes("sent");
  const addr = (list) => list && list.length ? list.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ") : null;
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
    labels: isSent ? ["sent"] : []
  };
}
function toFetchedMessage(parsed, uid, mailbox, account) {
  const isSent = mailbox.toLowerCase().includes("sent");
  return {
    // Prefixed with the account so the same IMAP uid in two different users'
    // mailboxes (both commonly start counting from 1) never collides in the
    // agentmail_message_id dedupe check on sync.
    message_id: `${account}:${mailbox}:${uid}`,
    thread_id: parsed.headers.get("thread-index") ?? null,
    from: parsed.from?.text ?? null,
    to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to?.text ?? null,
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    extracted_text: parsed.text ?? null,
    extracted_html: typeof parsed.html === "string" ? parsed.html : null,
    timestamp: parsed.date ? parsed.date.toISOString() : null,
    labels: isSent ? ["sent"] : []
  };
}

// src/lib/events.ts
async function insertEvent(db, e) {
  const id = crypto.randomUUID();
  const createdAt = e.created_at ?? (/* @__PURE__ */ new Date()).toISOString();
  const type = e.type ?? e.channel;
  const direction = e.direction ?? "internal";
  const content = e.content ?? e.summary ?? null;
  const handledBy = e.handled_by ?? "unhandled";
  await db.execute({
    sql: `INSERT INTO events
      (id, lead_id, channel, action, summary, source_ref, metadata, created_at,
       type, direction, content, handled_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      e.lead_id ?? null,
      e.channel,
      e.action,
      e.summary ?? null,
      e.source_ref ?? null,
      e.metadata !== void 0 ? JSON.stringify(e.metadata) : null,
      createdAt,
      type,
      direction,
      content,
      handledBy
    ]
  });
  if (e.lead_id) {
    const conv = await getOrCreateConversation(db, e.lead_id);
    await touchConversation(db, {
      conversation_id: conv.id,
      createdAt,
      direction,
      handledBy
    });
  }
  return id;
}

// src/lib/email-sync.ts
function extractEmail(from) {
  if (!from) return null;
  const s = String(from).trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s) || null;
}
function extractName(from) {
  if (!from) return null;
  const m = String(from).trim().match(/^(.*?)\s*<[^<>]+>$/);
  return m && m[1].trim() ? m[1].trim() : null;
}
function stripHtml(html) {
  if (!html) return null;
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, 2e3);
}
async function syncUserInbox(db, userId, mailCfg) {
  const res = await listMessages({ limit: 50 }, mailCfg);
  const msgs = Array.isArray(res.messages) ? res.messages : [];
  let synced = 0;
  for (const m of msgs) {
    if (!m.message_id) continue;
    if (Array.isArray(m.labels) && m.labels.includes("sent")) continue;
    const existing = (await db.execute({ sql: "SELECT id FROM email_messages WHERE agentmail_message_id = ?", args: [m.message_id] })).rows[0];
    if (existing) continue;
    let full = m;
    try {
      full = await getMessage(m.message_id, mailCfg);
    } catch {
    }
    const fromEmail = extractEmail(full.from);
    const toEmail = Array.isArray(full.to) ? full.to[0] ?? null : typeof full.to === "string" ? full.to : null;
    const body = full.extracted_text ?? full.text ?? stripHtml(full.extracted_html ?? full.html);
    let leadId = null;
    if (fromEmail) {
      const lead = (await db.execute({ sql: "SELECT id FROM leads WHERE email = ? AND user_id = ?", args: [fromEmail, userId] })).rows[0];
      if (lead) {
        leadId = lead.id;
      } else {
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const newId = crypto.randomUUID();
        const name = extractName(full.from) ?? fromEmail;
        await db.execute({
          sql: "INSERT INTO leads (id, user_id, name, email, source, status, score, last_activity, created_at) VALUES (?, ?, ?, ?, 'inbound email', 'new', ?, ?, ?)",
          args: [newId, userId, name, fromEmail, computeLeadScore({ email: fromEmail, name }), now, now]
        });
        leadId = newId;
      }
    }
    const emailRowId = crypto.randomUUID();
    const emailCreatedAt = full.timestamp ?? (/* @__PURE__ */ new Date()).toISOString();
    await db.execute({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, from_email, to_email, agentmail_message_id, agentmail_thread_id, created_at) VALUES (?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?)",
      args: [emailRowId, leadId, full.subject ?? null, body, fromEmail, toEmail, full.message_id, full.thread_id ?? null, emailCreatedAt]
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
      created_at: emailCreatedAt
    });
    synced++;
  }
  return { synced, total: msgs.length };
}

// src/lib/whatsapp.ts
var DEFAULT_SESSION = "default";
function env(name) {
  return (process.env[name] ?? "").trim();
}
function whatsappConfig() {
  const apiKey = env("RELAYX_API_KEY");
  return {
    enabled: Boolean(apiKey),
    base: (env("RELAYX_BASE_URL") || "").replace(/\/+$/, ""),
    apiKey,
    session: env("RELAYX_SESSION") || DEFAULT_SESSION,
    fromNumber: env("RELAYX_FROM_NUMBER"),
    webhookSecret: env("RELAYX_WEBHOOK_SECRET")
  };
}
function normalizePhone(raw) {
  return (raw ?? "").replace(/[^\d]/g, "");
}
function phoneMatches(a, b) {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  const len = Math.min(10, Math.min(na.length, nb.length));
  if (len === 0) return false;
  return na.slice(-len) === nb.slice(-len);
}
function authorizeWebhook(authHeader) {
  const cfg = whatsappConfig();
  if (!cfg.webhookSecret) return { ok: true };
  if (!authHeader) return { ok: false };
  return { ok: authHeader === cfg.webhookSecret };
}
function normalizeInbound(body) {
  const out = [];
  const b = body ?? {};
  if (b.event === "message" && b.data) {
    const m = fromWaWebJs(b.data);
    if (m) out.push(m);
    return out;
  }
  if (Array.isArray(b.messages)) {
    for (const raw of b.messages) {
      const m = fromWaWebJs(raw);
      if (m) out.push(m);
    }
    if (out.length) return out;
  }
  if (b.object === "whatsapp_business_account") {
    const entries = Array.isArray(b.entry) ? b.entry : [];
    for (const entry of entries) {
      const changes = entry?.changes;
      if (!Array.isArray(changes)) continue;
      for (const ch of changes) {
        const msgs = ch?.value?.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          const n = fromMeta(m);
          if (n) out.push(n);
        }
      }
    }
    if (out.length) return out;
  }
  if (typeof b.from === "string") {
    out.push({
      from: b.from,
      body: typeof b.body === "string" ? b.body : "",
      contactName: typeof b.pushName === "string" ? b.pushName : typeof b.contactName === "string" ? b.contactName : null,
      fromMe: Boolean(b.fromMe),
      timestamp: typeof b.timestamp === "number" ? new Date(b.timestamp * 1e3).toISOString() : null,
      providerMessageId: String(b.id ?? b.providerMessageId ?? `${b.from}-${Date.now()}`),
      messageType: typeof b.messageType === "string" ? b.messageType : "text"
    });
    return out;
  }
  return out;
}
function fromWaWebJs(m) {
  const key = m?.key ?? m;
  const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : typeof key?.jid === "string" ? key.jid : void 0;
  if (!remoteJid) return null;
  const phone = remoteJid.split("@")[0]?.trim() ?? remoteJid;
  const fromMe = Boolean(key?.fromMe);
  const msg = m?.message ?? {};
  let text = "";
  const conv = msg.conversation;
  if (typeof conv === "string") text = conv;
  else {
    const ext = msg.extendedTextMessage;
    if (typeof ext?.text === "string") text = ext.text;
    else {
      const txt = msg.text;
      if (typeof txt?.body === "string") text = txt.body;
      else {
        const img = msg.imageMessage;
        if (typeof img?.caption === "string") text = `[image] ${img.caption}`;
        else {
          const vid = msg.videoMessage;
          if (typeof vid?.caption === "string") text = `[video] ${vid.caption}`;
          else if (msg.audioMessage && typeof msg.audioMessage === "object") text = "[audio]";
          else if (msg.documentMessage && typeof msg.documentMessage === "object") text = "[document]";
          else if (msg.stickerMessage && typeof msg.stickerMessage === "object") text = "[sticker]";
          else if (msg.locationMessage && typeof msg.locationMessage === "object") text = "[location]";
        }
      }
    }
  }
  const tsNum = typeof m?.messageTimestamp === "number" ? m.messageTimestamp : typeof m?.timestamp === "number" ? m.timestamp : NaN;
  return {
    from: phone,
    body: text,
    contactName: typeof m?.pushName === "string" ? m.pushName : null,
    fromMe,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1e3).toISOString() : null,
    providerMessageId: String(key?.id ?? m?.id ?? `${phone}-${Date.now()}`),
    messageType: guessMessageType(msg)
  };
}
function fromMeta(m) {
  if (typeof m?.from !== "string") return null;
  const tsNum = typeof m?.timestamp === "number" ? m.timestamp : NaN;
  let text = "";
  const txt2 = m.text;
  if (typeof txt2?.body === "string") text = txt2.body;
  else if (m?.type === "image") text = "[image]";
  else if (m?.type === "audio") text = "[audio]";
  else if (m?.type === "document") text = "[document]";
  else if (m?.type === "sticker") text = "[sticker]";
  else if (m?.type === "location") text = "[location]";
  else if (m?.type === "contacts") text = "[contact]";
  else text = "";
  return {
    from: m.from,
    body: text,
    contactName: typeof m?.pushName === "string" ? m.pushName : null,
    fromMe: false,
    timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1e3).toISOString() : null,
    providerMessageId: String(m?.id ?? `${m.from}-${Date.now()}`),
    messageType: typeof m?.type === "string" ? m.type : "text"
  };
}
function guessMessageType(msg) {
  if (msg.conversation) return "text";
  const ext = msg.extendedTextMessage;
  if (typeof ext?.text === "string") return "text";
  const txt = msg.text;
  if (typeof txt?.body === "string") return "text";
  if (msg.imageMessage) return "image";
  if (msg.videoMessage) return "video";
  if (msg.audioMessage) return "audio";
  if (msg.documentMessage) return "document";
  if (msg.stickerMessage) return "sticker";
  if (msg.locationMessage) return "location";
  if (msg.contactMessage) return "contact";
  return "text";
}
async function sendText(to, text) {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };
  const chatId = `${normalizePhone(to)}@c.us`;
  const url = `${cfg.base}/api/sendText`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        text
      })
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `WhatsApp send failed (${res.status}): ${detail.slice(0, 500)}` };
  }
  const json = await res.json().catch(() => ({}));
  const providerMessageId = json?.message?.id ?? json?.messages?.[0]?.id ?? json?.id ?? null;
  return { ok: true, providerMessageId };
}
async function sendMedia(to, file) {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (RELAYX_API_KEY)" };
  if (!cfg.base) return { ok: false, providerMessageId: null, error: "RELAYX_BASE_URL is not set" };
  const chatId = `${normalizePhone(to)}@c.us`;
  const url = `${cfg.base}/api/sendMedia`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": cfg.apiKey
      },
      body: JSON.stringify({
        session: cfg.session,
        chatId,
        base64: file.base64,
        mimetype: file.mimetype,
        filename: file.filename,
        ...file.caption ? { caption: file.caption } : {}
      })
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${e.message}` };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `Media send failed (${res.status}): ${detail.slice(0, 300)}` };
  }
  const json = await res.json().catch(() => ({}));
  const providerMessageId = json?.message?.id ?? json?.messages?.[0]?.id ?? json?.id ?? null;
  return { ok: true, providerMessageId };
}
function workingHoursConfig() {
  return {
    start: env("RELAYX_WORKING_HOURS_START") || "09:00",
    // 24h "HH:MM"
    end: env("RELAYX_WORKING_HOURS_END") || "18:00",
    tz: env("RELAYX_WORKING_TZ") || "America/New_York"
  };
}
function isWithinWorkingHours(date) {
  const { start, end, tz } = workingHoursConfig();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + (sm || 0);
  const e = eh * 60 + (em || 0);
  return mins >= s && mins < e;
}
function autoAckText() {
  return "Thanks for reaching out \u2014 we got your message. Our team will get back to you shortly. \u{1F64C}";
}

// src/routes/messages.ts
var router3 = new Hono3();
async function ownedLeadIds(db, userId, leadIds) {
  const ids = Array.from(new Set(leadIds)).filter(Boolean);
  if (!ids.length) return /* @__PURE__ */ new Set();
  const placeholders = ids.map(() => "?").join(",");
  const rows = (await db.execute({ sql: `SELECT id FROM leads WHERE user_id = ? AND id IN (${placeholders})`, args: [userId, ...ids] })).rows;
  return new Set(rows.map((r) => r.id));
}
async function userOwnsEmail(db, userId, emailId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM email_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [emailId, userId]
  })).rows[0];
  return !!row;
}
async function userOwnsWhatsapp(db, userId, msgId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [msgId, userId]
  })).rows[0];
  return !!row;
}
async function userOwnsCall(db, userId, callId) {
  const row = (await db.execute({
    sql: `SELECT m.id FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE m.id = ? AND l.user_id = ?`,
    args: [callId, userId]
  })).rows[0];
  return !!row;
}
async function userMailerConfig(db, userId) {
  const row = (await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })).rows[0];
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user \u2014 ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var attachmentSchema = z3.array(
  z3.object({
    filename: z3.string().min(1).max(255),
    contentType: z3.string().max(120),
    data: z3.string().min(1)
  })
).max(6).optional();
function parseAttachments(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
router3.get("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({ sql: "SELECT * FROM chat_messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 50", args: [user.id] })).rows;
  return c.json(rows);
});
router3.post("/chat", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z3.object({ role: z3.enum(["user", "assistant"]), content: z3.string(), citations: z3.array(z3.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  await (await getDb()).execute({
    sql: "INSERT INTO chat_messages (id, user_id, role, content, citations) VALUES (?, ?, ?, ?, ?)",
    args: [id, user.id, role, content, citations ? JSON.stringify(citations) : null]
  });
  return c.json({ id });
});
router3.get("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM email_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/emails", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(
    z3.object({
      lead_id: z3.string(),
      subject: z3.string(),
      body: z3.string(),
      tone: z3.string().optional(),
      goal: z3.string().optional(),
      status: z3.string().optional(),
      attachments: attachmentSchema
    })
  ).parse(await c.req.json());
  const db = await getDb();
  const leadIds = Array.from(new Set(data.map((r) => r.lead_id)));
  const owned = await ownedLeadIds(db, user.id, leadIds);
  const items = [];
  const statements = [];
  for (const r of data) {
    if (!owned.has(r.lead_id)) continue;
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    statements.push({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null]
    });
  }
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true, items });
});
router3.post("/emails/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), opened_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsEmail(db, user.id, d.id)) return c.json({ error: "Email not found" }, 404);
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.opened_at) {
    sets.push("opened_at = ?");
    vals.push(d.opened_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});
router3.post("/emails/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id } = z3.object({ id: z3.string() }).parse(await c.req.json());
  const db = await getDb();
  const row = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
  if (!row) return c.json({ error: "Email not found" }, 404);
  if (!row.lead_id || !(await ownedLeadIds(db, user.id, [row.lead_id])).has(row.lead_id)) {
    return c.json({ error: "Email not found" }, 404);
  }
  const lead = (await db.execute({ sql: "SELECT email FROM leads WHERE id = ?", args: [row.lead_id] })).rows[0];
  if (!lead?.email) return c.json({ error: "Lead has no email address \u2014 add one before sending" }, 400);
  const attachments = parseAttachments(row.attachments).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.data, "base64")
  }));
  try {
    const mailCfg = await userMailerConfig(db, user.id);
    const sent = await sendMessage({ to: lead.email, subject: row.subject, text: row.body, attachments }, mailCfg);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await db.execute({
      sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
      args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id]
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
      created_at: now
    });
    const updated = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
    return c.json(updated);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});
router3.post("/emails/sync", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  let mailCfg;
  try {
    mailCfg = await userMailerConfig(db, user.id);
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
  try {
    const result = await syncUserInbox(db, user.id, mailCfg);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e.message }, 502);
  }
});
router3.get("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM whatsapp_messages m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/whatsapps", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), body: z3.string(), status: z3.string().optional(), attachments: attachmentSchema })).parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const items = [];
  const statements = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    items.push({ id, lead_id: r.lead_id });
    return [
      { sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status, attachments) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.body, r.status ?? "draft", r.attachments && r.attachments.length ? JSON.stringify(r.attachments) : null] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "draft", r.body.slice(0, 120), id, now] }
    ];
  });
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true, items });
});
router3.post("/whatsapps/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), read_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsWhatsapp(db, user.id, d.id)) return c.json({ error: "WhatsApp message not found" }, 404);
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.read_at) {
    sets.push("read_at = ?");
    vals.push(d.read_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const w = (await db.execute({ sql: "SELECT lead_id FROM whatsapp_messages WHERE id = ?", args: [d.id] })).rows[0];
  await insertEvent(db, { lead_id: w?.lead_id ?? null, channel: "whatsapp", action: d.status, source_ref: d.id });
  return c.json({ success: true });
});
router3.post("/whatsapps/send", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string().optional(), lead_id: z3.string().optional(), body: z3.string().optional(), attachments: attachmentSchema }).parse(await c.req.json());
  const db = await getDb();
  let messageId = d.id ?? "";
  let leadId = d.lead_id ?? null;
  let body = d.body ?? "";
  let fromNumber = null;
  let attachments = [];
  if (!messageId && (leadId && body)) {
    if (!(await ownedLeadIds(db, user.id, [leadId])).has(leadId)) return c.json({ error: "Lead not found" }, 404);
    const cfg = whatsappConfig();
    const newId = crypto.randomUUID();
    const lead2 = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0];
    if (!lead2?.phone) return c.json({ error: "Lead has no phone number \u2014 add one before sending" }, 400);
    attachments = d.attachments ?? [];
    await db.execute({
      sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, from_number, to_number, status, attachments) VALUES (?, ?, ?, 'outbound', ?, ?, 'draft', ?)",
      args: [newId, leadId, body, cfg.fromNumber || null, lead2.phone, attachments.length ? JSON.stringify(attachments) : null]
    });
    messageId = newId;
    fromNumber = cfg.fromNumber || null;
  } else if (messageId) {
    if (!await userOwnsWhatsapp(db, user.id, messageId)) return c.json({ error: "WhatsApp message not found" }, 404);
    const row = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0];
    if (!row) return c.json({ error: "WhatsApp message not found" }, 404);
    leadId = row.lead_id;
    body = row.body;
    fromNumber = row.from_number ?? whatsappConfig().fromNumber ?? null;
    attachments = parseAttachments(row.attachments);
  }
  if (!leadId) return c.json({ error: "Message is not linked to a lead" }, 400);
  if (!body) return c.json({ error: "Nothing to send \u2014 message body is empty" }, 400);
  const lead = (await db.execute({ sql: "SELECT phone FROM leads WHERE id = ?", args: [leadId] })).rows[0];
  if (!lead?.phone) return c.json({ error: "Lead has no phone number \u2014 add one before sending" }, 400);
  let send;
  try {
    send = await sendText(lead.phone, body);
  } catch (e) {
    console.error("SEND TEXT THREW:", e);
    send = { ok: false, providerMessageId: null, error: e.message };
  }
  if (!send.ok) return c.json({ error: send.error ?? "WhatsApp send failed" }, 502);
  const attachmentErrors = [];
  for (const a of attachments) {
    try {
      const media = await sendMedia(lead.phone, { base64: a.data, mimetype: a.contentType, filename: a.filename });
      if (!media.ok) attachmentErrors.push(`${a.filename}: ${media.error ?? "failed"}`);
    } catch (e) {
      attachmentErrors.push(`${a.filename}: ${e.message}`);
    }
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ?, to_number = ?, from_number = ?, direction = 'outbound' WHERE id = ?",
    args: [now, send.providerMessageId, lead.phone, fromNumber, messageId]
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
    created_at: now
  });
  const updated = (await db.execute({ sql: "SELECT * FROM whatsapp_messages WHERE id = ?", args: [messageId] })).rows[0];
  if (attachmentErrors.length) {
    return c.json({ ...updated, warning: `Text sent, but ${attachmentErrors.length} attachment${attachmentErrors.length === 1 ? "" : "s"} failed: ${attachmentErrors.join("; ")}` });
  }
  return c.json(updated);
});
router3.get("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id
          WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/calls", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), goal: z3.string().optional(), voice: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const owned = await ownedLeadIds(db, user.id, data.map((r) => r.lead_id));
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const statements = data.filter((r) => owned.has(r.lead_id)).flatMap((r) => {
    const id = crypto.randomUUID();
    return [
      { sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "queued", r.goal ?? null, id, now] }
    ];
  });
  if (statements.length) await db.batch(statements, "write");
  const rows = (await db.execute({
    sql: `SELECT m.* FROM call_logs m JOIN leads l ON l.id = m.lead_id WHERE l.user_id = ? ORDER BY m.created_at DESC LIMIT 50`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/calls/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string().optional(), outcome: z3.string().optional(), transcript: z3.any().optional(), summary: z3.string().optional(), duration_sec: z3.number().optional(), started_at: z3.string().optional(), ended_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!await userOwnsCall(db, user.id, d.id)) return c.json({ error: "Call not found" }, 404);
  const sets = [];
  const vals = [];
  if (d.status !== void 0) {
    sets.push("status = ?");
    vals.push(d.status);
  }
  if (d.outcome !== void 0) {
    sets.push("outcome = ?");
    vals.push(d.outcome);
  }
  if (d.transcript !== void 0) {
    sets.push("transcript = ?");
    vals.push(JSON.stringify(d.transcript));
  }
  if (d.summary !== void 0) {
    sets.push("summary = ?");
    vals.push(d.summary);
  }
  if (d.duration_sec !== void 0) {
    sets.push("duration_sec = ?");
    vals.push(d.duration_sec);
  }
  if (d.started_at !== void 0) {
    sets.push("started_at = ?");
    vals.push(d.started_at);
  }
  if (d.ended_at !== void 0) {
    sets.push("ended_at = ?");
    vals.push(d.ended_at);
  }
  if (!sets.length) return c.json({ success: true });
  vals.push(d.id);
  await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const cl = (await db.execute({ sql: "SELECT lead_id FROM call_logs WHERE id = ?", args: [d.id] })).rows[0];
  await insertEvent(db, { lead_id: cl?.lead_id ?? null, channel: "call", action: d.outcome ?? d.status ?? "updated", source_ref: d.id });
  return c.json({ success: true });
});
router3.get("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute({
    sql: `SELECT a.id, a.title, a.scheduled_at, a.lead_id FROM appointments a JOIN leads l ON l.id = a.lead_id
          WHERE l.user_id = ? ORDER BY a.scheduled_at ASC LIMIT 20`,
    args: [user.id]
  })).rows;
  return c.json(rows);
});
router3.post("/appointments", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ lead_id: z3.string(), call_id: z3.string().optional(), title: z3.string(), scheduled_at: z3.string(), duration_min: z3.number().optional(), status: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  if (!(await ownedLeadIds(db, user.id, [d.lead_id])).has(d.lead_id)) return c.json({ error: "Lead not found" }, 404);
  await db.execute({
    sql: "INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"]
  });
  return c.json({ success: true });
});
var messages_default = router3;

// src/routes/ai.ts
import { Hono as Hono4 } from "hono";
import { z as z4 } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool, isStepCount } from "ai";
async function userMailerConfig2(db, userId) {
  const row = (await db.execute({ sql: "SELECT gmail_email, gmail_app_password FROM users WHERE id = ?", args: [userId] })).rows[0];
  const user = row?.gmail_email || process.env.GMAIL_USER;
  const appPassword = row?.gmail_app_password || process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("No email account configured for this user \u2014 ask your admin to set one in the Admin panel.");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
}
var router4 = new Hono4();
var MODEL = process.env.AI_MODEL ?? "openai/gpt-5.6-luna";
function gateway() {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Missing AI_API_KEY or AI_BASE_URL");
  return createOpenAICompatible({ name: "ai-provider", apiKey, baseURL });
}
function leadsBlock(leads) {
  return leads.map((l) => {
    const budget = l.budget_max ? `$${Number(l.budget_max).toLocaleString()}` : "";
    const extras = [
      l.interest ? `interest=${l.interest}` : "",
      l.category ? `category=${l.category}` : "",
      l.region ? `region=${l.region}` : "",
      budget ? `budget=${budget}` : "",
      l.urgency ? `urgency=${l.urgency}` : "",
      l.notes ? `notes="${l.notes}"` : ""
    ].filter(Boolean).join(" \xB7 ");
    return `- [${l.id.slice(0, 8)}] ${l.name} \xB7 ${l.company ?? ""} \xB7 ${l.city ?? ""} \xB7 email=${l.email ?? "\u2014"} \xB7 phone=${l.phone ?? "\u2014"} \xB7 status=${l.status} \xB7 score=${l.score}${extras ? ` \xB7 ${extras}` : ""}`;
  }).join("\n");
}
var historySchema = z4.array(z4.object({ role: z4.enum(["user", "assistant"]), content: z4.string() }));
function buildChatTools(userId) {
  return {
    send_email: tool({
      description: "Send a real email to a lead through the connected inbox (SMTP). The email is delivered immediately and recorded in Email Studio. Call this when the user asks to send, email, or mail a lead \u2014 compose the subject and body yourself from the lead's details and requirements.",
      inputSchema: z4.object({
        lead_id: z4.string().describe("The lead's id \u2014 its full UUID or the first 8 characters shown in the leads list."),
        subject: z4.string().describe("Email subject line."),
        body: z4.string().describe("Plain-text email body. Personalize with the lead's name and their specific needs.")
      }),
      execute: async ({ lead_id, subject, body }) => {
        const db = await getDb();
        const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0];
        if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
        if (!lead.email) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no email address on file \u2014 add one first` };
        let mailCfg;
        try {
          mailCfg = await userMailerConfig2(db, userId);
        } catch (e) {
          return { ok: false, error: e.message };
        }
        const id = crypto.randomUUID();
        await db.execute({
          sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, created_at) VALUES (?, ?, ?, ?, 'outbound', 'draft', ?)",
          args: [id, lead.id, subject, body, (/* @__PURE__ */ new Date()).toISOString()]
        });
        try {
          const sent = await sendMessage({ to: lead.email, subject, text: body }, mailCfg);
          const now = (/* @__PURE__ */ new Date()).toISOString();
          await db.execute({
            sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
            args: [now, mailCfg.user, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id]
          });
          await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
          await insertEvent(db, {
            lead_id: lead.id,
            channel: "email",
            type: "email",
            direction: "outbound",
            handled_by: "human",
            action: "sent",
            summary: subject,
            content: body,
            source_ref: id,
            metadata: { to: lead.email, message_id: sent.message_id ?? null, via: "ai-chat" },
            created_at: now
          });
          return { ok: true, email_id: id, to: lead.email, subject };
        } catch (e) {
          await db.execute({ sql: "UPDATE email_messages SET status = 'draft' WHERE id = ?", args: [id] });
          return { ok: false, error: `Sending failed: ${e.message}. The email was saved as a draft in Email Studio.` };
        }
      }
    }),
    send_whatsapp: tool({
      description: "Send a real WhatsApp message to a lead. The message is delivered immediately and recorded in WhatsApp. Call this when the user asks to send a WhatsApp or message a lead.",
      inputSchema: z4.object({
        lead_id: z4.string().describe("The lead's id \u2014 its full UUID or the first 8 characters shown in the leads list."),
        body: z4.string().describe("WhatsApp message text, 1-3 sentences, personalized with the lead's name and needs.")
      }),
      execute: async ({ lead_id, body }) => {
        const db = await getDb();
        const lead = (await db.execute({ sql: "SELECT * FROM leads WHERE (id = ? OR substr(id, 1, 8) = ?) AND user_id = ? LIMIT 1", args: [lead_id, lead_id, userId] })).rows[0];
        if (!lead) return { ok: false, error: `No lead found with id ${lead_id}` };
        if (!lead.phone) return { ok: false, error: `Lead ${lead.name ?? lead_id} has no phone number on file \u2014 add one first` };
        const id = crypto.randomUUID();
        await db.execute({
          sql: "INSERT INTO whatsapp_messages (id, lead_id, body, direction, to_number, status, created_at) VALUES (?, ?, ?, 'outbound', ?, 'draft', ?)",
          args: [id, lead.id, body, lead.phone, (/* @__PURE__ */ new Date()).toISOString()]
        });
        try {
          const send = await sendText(lead.phone, body);
          if (!send.ok) throw new Error(send.error ?? "WhatsApp send failed");
          const now = (/* @__PURE__ */ new Date()).toISOString();
          await db.execute({
            sql: "UPDATE whatsapp_messages SET status = 'sent', sent_at = ?, provider_message_id = ? WHERE id = ?",
            args: [now, send.providerMessageId, id]
          });
          await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, lead.id] });
          await insertEvent(db, {
            lead_id: lead.id,
            channel: "whatsapp",
            type: "whatsapp",
            direction: "outbound",
            handled_by: "human",
            action: "sent",
            summary: body.slice(0, 120),
            content: body,
            source_ref: id,
            metadata: { to: lead.phone, provider_message_id: send.providerMessageId, via: "ai-chat" },
            created_at: now
          });
          return { ok: true, message_id: id, to: lead.phone };
        } catch (e) {
          await db.execute({ sql: "UPDATE whatsapp_messages SET status = 'draft' WHERE id = ?", args: [id] });
          return { ok: false, error: `Sending failed: ${e.message}. The message was saved as a draft in WhatsApp.` };
        }
      }
    })
  };
}
router4.post("/chat", async (c) => {
  const authedUser = await authenticate(c);
  if (!authedUser) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads, history } = z4.object({ question: z4.string(), leads: z4.array(z4.any()), history: historySchema.optional() }).parse(await c.req.json());
  const ai = gateway();
  let text;
  try {
    const res = await generateText({
      model: ai(MODEL),
      system: `You are an assistant for a lead-management CRM (prospects, customers, deals). Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads or their data, and never substitute a different lead when the one being discussed lacks a field \u2014 say that field is missing instead. The conversation may reference a lead named earlier in the thread \u2014 use that context to resolve follow-up questions (e.g. "his email" or "show me his number" refers to the lead just discussed, not a different one). You have two real tools: send_email and send_whatsapp. Use them ONLY when the user explicitly asks you to send an email or WhatsApp message to a specific lead. Compose the content yourself from the lead's requirements. After a tool succeeds, confirm briefly what was sent and to whom. If a tool reports an error, tell the user what happened and what they can do (e.g. add the missing email/phone, or send from Email Studio).`,
      messages: [
        { role: "user", content: `Leads (${leads.length}):
${leadsBlock(leads)}` },
        ...history ?? [],
        { role: "user", content: question }
      ],
      tools: buildChatTools(authedUser.id),
      stopWhen: isStepCount(5),
      // The gateway rejects function tools combined with reasoning_effort on
      // this model (/v1/chat/completions) — explicitly disable reasoning so
      // tool calling is allowed.
      providerOptions: { "ai-provider": { reasoningEffort: "none" } }
    });
    text = res.text;
  } catch (e) {
    console.error("[ai/chat] generateText failed:", e);
    throw e;
  }
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => leads.find((l) => l.id.startsWith(short))?.id).filter(Boolean);
  return c.json({ text, citations: cited });
});
router4.post("/email", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z4.object({ lead: z4.any(), tone: z4.string(), goal: z4.string(), senderName: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: `You write short, high-converting sales and outreach emails for a small business (introductions, proposals, follow-ups, check-ins). Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.`,
    prompt: `Tone: ${tone}
Goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({ subject: j.subject ?? "", body: j.body ?? "" });
  } catch {
    return c.json({ subject: "", body: text });
  }
});
router4.post("/whatsapp", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z4.object({ lead: z4.any(), intent: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: "Write a friendly, concise follow-up WhatsApp message (1-3 sentences, max 280 chars) \u2014 e.g. appointment reminders, quick check-ins, or next-step updates. Use the lead's first name. One emoji max. Return ONLY the message body.",
    prompt: `Intent: ${intent}
Lead: ${JSON.stringify(lead)}`
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});
router4.post("/call", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z4.object({ lead: z4.any(), goal: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'Design AI voice agent call flows for a sales team (qualify prospects, book meetings, discuss proposals). Return strict JSON: {"opening":"...","talking_points":["..."],"objection_handling":["..."],"closing":"...","mock_transcript":[{"speaker":"agent|lead","text":"..."}],"summary":"...","suggested_outcome":"booked|interested|callback|not_interested|voicemail","book_appointment":true|false}. Transcript should be 6-10 turns.',
    prompt: `Call goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    return c.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch {
    return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] });
  }
});
router4.post("/post", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { topic, platform, audience, tone } = z4.object({ topic: z4.string().min(1), platform: z4.string().optional(), audience: z4.string().optional(), tone: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'You are a social media copywriter for a small business (product updates, launches, customer wins, industry insights). Return strict JSON: {"caption":"...","hashtags":["#tag","#tag"],"image_prompt":"..."}. The caption must be ready to post: 1-3 short paragraphs, 1-2 emojis, natural line breaks, tailored to the platform and audience. Hashtags: exactly 5-8 relevant tags as an array of strings including the # (e.g. #NewProduct, #BehindTheScenes, #CustomerStory, location tags). image_prompt: a detailed English visual prompt (150-220 words) describing a striking, on-brand image for this post \u2014 subject, composition, lighting, colors, mood, and any text/graphic elements.',
    prompt: `Topic: ${topic}
Platform: ${platform ?? "Instagram"}
Target audience: ${audience || "general"}
Tone: ${tone || "energetic and inspiring"}`
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({
      caption: j.caption ?? "",
      hashtags: Array.isArray(j.hashtags) ? j.hashtags.map(String) : [],
      image_prompt: j.image_prompt ?? topic
    });
  } catch {
    return c.json({ caption: text, hashtags: [], image_prompt: topic });
  }
});
router4.post("/image", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { prompt, size } = z4.object({ prompt: z4.string(), size: z4.string().optional() }).parse(await c.req.json());
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) return c.json({ error: "Missing AI_API_KEY or AI_BASE_URL" }, 500);
  const model = process.env.AI_IMAGE_MODEL ?? "gpt-image-2";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/images/generations`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: size ?? "auto" })
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return c.json({ error: `Image generation failed (${upstream.status}): ${detail.slice(0, 500)}` }, 502);
  }
  const json = await upstream.json();
  const item = json.data?.[0];
  if (item?.b64_json) return c.json({ image: `data:image/png;base64,${item.b64_json}` });
  if (item?.url) return c.json({ image: item.url });
  return c.json({ error: "No image returned by the model" }, 502);
});
var ai_default = router4;

// src/routes/conversations.ts
import { Hono as Hono5 } from "hono";
import { z as z5 } from "zod";
var router5 = new Hono5();
function enrichSla(conv) {
  if (conv && typeof conv === "object") {
    conv.sla_status = computeSlaStatus(conv.sla_due_at ?? null);
  }
  return conv;
}
router5.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const status = c.req.query("status");
  const sla = c.req.query("sla");
  const db = await getDb();
  let rows = (await db.execute({
    sql: `
    SELECT c.id, c.lead_id, c.status, c.sla_due_at, c.sla_status,
           c.first_event_at, c.last_event_at, c.created_at,
           l.name AS lead_name, l.company, l.city, l.phone, l.email, l.source,
           (SELECT content FROM events e WHERE e.conversation_id = c.id ORDER BY e.created_at DESC LIMIT 1) AS last_content,
           (SELECT created_at FROM events e WHERE e.conversation_id = c.id ORDER BY e.created_at DESC LIMIT 1) AS last_event_created
    FROM conversations c JOIN leads l ON l.id = c.lead_id
    WHERE l.user_id = ?
    ORDER BY COALESCE(c.last_event_at, c.created_at) DESC
  `,
    args: [user.id]
  })).rows;
  rows = rows.map(enrichSla);
  if (status) rows = rows.filter((r) => r.status === status);
  if (sla) rows = rows.filter((r) => r.sla_status === sla);
  return c.json(rows);
});
router5.get("/:id", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.*, l.name AS lead_name, l.company, l.city, l.phone, l.email, l.source, l.status AS lead_status
          FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  const events = (await db.execute({
    sql: `SELECT id, type, channel, direction, content, handled_by, action, summary, source_ref, metadata, created_at
          FROM events WHERE conversation_id = ? ORDER BY created_at ASC`,
    args: [conv.id]
  })).rows;
  return c.json({ conversation: enrichSla(conv), events });
});
router5.post("/:id/events", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z5.object({ content: z5.string().min(1), handled_by: z5.enum(["human", "ai"]).optional() }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.lead_id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  await insertEvent(db, {
    lead_id: conv.lead_id,
    channel: "note",
    type: "note",
    direction: "internal",
    handled_by: d.handled_by ?? "human",
    action: "note",
    summary: d.content.slice(0, 120),
    content: d.content,
    metadata: { note: true }
  });
  return c.json({ success: true });
});
router5.post("/:id/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const d = z5.object({ status: z5.enum(["new", "active", "awaiting_reply", "resolved", "archived"]) }).parse(await c.req.json());
  const db = await getDb();
  const conv = (await db.execute({
    sql: `SELECT c.id FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE c.id = ? AND l.user_id = ?`,
    args: [c.req.param("id"), user.id]
  })).rows[0];
  if (!conv) return c.json({ error: "Conversation not found" }, 404);
  await setConversationStatus(db, c.req.param("id"), d.status);
  return c.json({ success: true });
});
var conversations_default = router5;

// src/routes/whatsapp-webhook.ts
import { Hono as Hono6 } from "hono";
var ACK_DEBOUNCE_MS = 5 * 60 * 1e3;
var router6 = new Hono6();
router6.get("/", (c) => c.text("ok"));
router6.post("/", async (c) => {
  const authHeader = c.req.header("x-webhook-secret") ?? c.req.header("x-api-key");
  const { ok } = authorizeWebhook(authHeader);
  if (!ok) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const inbound = normalizeInbound(body);
  if (!inbound.length) return c.json({ status: "ok", received: 0 });
  const db = await getDb();
  const cfg = whatsappConfig();
  let receivedCount = 0;
  for (const msg of inbound) {
    const dup = (await db.execute({
      sql: "SELECT id FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1",
      args: [msg.providerMessageId]
    })).rows[0];
    if (dup) continue;
    const leadId = await findOrCreateLead(db, msg);
    const now = msg.timestamp || (/* @__PURE__ */ new Date()).toISOString();
    const inboundId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO whatsapp_messages
        (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'received', ?)`,
      args: [
        inboundId,
        leadId,
        msg.body,
        msg.from,
        cfg.fromNumber || null,
        msg.providerMessageId,
        now
      ]
    });
    await insertEvent(db, {
      lead_id: leadId,
      channel: "whatsapp",
      type: "whatsapp",
      direction: "inbound",
      handled_by: "unhandled",
      action: "received",
      summary: msg.body.slice(0, 120),
      content: msg.body,
      source_ref: msg.providerMessageId,
      metadata: { from: msg.from, to: cfg.fromNumber || null, message_type: msg.messageType, fromMe: msg.fromMe },
      created_at: now
    });
    let acknowledged = false;
    if (!isWithinWorkingHours(/* @__PURE__ */ new Date())) {
      acknowledged = await maybeAutoAck(db, msg, inboundId, cfg.fromNumber);
    }
    if (acknowledged) {
      await db.execute({
        sql: "UPDATE whatsapp_messages SET acknowledged_at = ? WHERE id = ?",
        args: [(/* @__PURE__ */ new Date()).toISOString(), inboundId]
      });
    }
    receivedCount++;
  }
  return c.json({ status: "ok", received: receivedCount });
});
async function findOrCreateLead(db, msg) {
  const rows = (await db.execute("SELECT id, phone FROM leads WHERE phone IS NOT NULL AND phone != ''")).rows;
  for (const r of rows) {
    if (phoneMatches(r.phone, msg.from)) return r.id;
  }
  const id = crypto.randomUUID();
  const name = msg.contactName?.trim() || msg.from;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: `INSERT INTO leads (id, name, phone, source, status, score, last_activity, created_at)
      VALUES (?, ?, ?, 'whatsapp inbound', 'new', 0, ?, ?)`,
    args: [id, name, normalizePhone(msg.from), now, now]
  });
  return id;
}
async function maybeAutoAck(db, msg, inboundId, fromNumber) {
  if (!fromNumber) return false;
  const recent = (await db.execute({
    sql: `SELECT id FROM whatsapp_messages
        WHERE direction = 'outbound' AND to_number = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
    args: [msg.from, new Date(Date.now() - ACK_DEBOUNCE_MS).toISOString()]
  })).rows[0];
  if (recent) return false;
  const send = await sendText(msg.from, autoAckText());
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db.execute({
    sql: `INSERT INTO whatsapp_messages
      (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
      VALUES (?, NULL, ?, 'outbound', ?, ?, ?, 'sent', ?)`,
    args: [
      crypto.randomUUID(),
      autoAckText(),
      fromNumber,
      normalizePhone(msg.from),
      send.providerMessageId,
      now
    ]
  });
  await insertEvent(db, {
    lead_id: null,
    channel: "whatsapp",
    type: "whatsapp",
    direction: "outbound",
    handled_by: "human",
    action: "auto-acknowledged",
    summary: autoAckText().slice(0, 120),
    content: autoAckText(),
    source_ref: inboundId,
    metadata: { to: msg.from, provider_message_id: send.providerMessageId, off_hours: true },
    created_at: now
  });
  return send.ok;
}
var whatsapp_webhook_default = router6;

// src/routes/admin.ts
import { Hono as Hono7 } from "hono";
import { z as z6 } from "zod";
import bcrypt2 from "bcryptjs";
var router7 = new Hono7();
router7.use("/*", async (c, next) => {
  const admin = await authenticateAdmin(c);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  c.set("admin", admin);
  await next();
});
var createUserSchema = z6.object({
  name: z6.string().min(1).optional(),
  email: z6.string().email(),
  password: z6.string().min(6),
  is_admin: z6.boolean().optional(),
  gmail_email: z6.string().email().optional().or(z6.literal("")),
  gmail_app_password: z6.string().optional().or(z6.literal(""))
});
var updateEmailCredsSchema = z6.object({
  gmail_email: z6.string().email().optional().or(z6.literal("")),
  gmail_app_password: z6.string().optional().or(z6.literal(""))
});
var resetPasswordSchema = z6.object({ password: z6.string().min(6) });
var USER_COLUMNS = "id, name, email, is_admin, disabled, gmail_email, created_at";
async function syncInboxNow(db, userId, gmailEmail, gmailAppPassword) {
  const mailCfg = {
    user: gmailEmail,
    appPassword: gmailAppPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com"
  };
  try {
    return await syncUserInbox(db, userId, mailCfg);
  } catch (err) {
    console.error(`[admin] first-sync failed for user ${userId}:`, err);
    return null;
  }
}
function shapeUser(r) {
  return { ...r, is_admin: !!r.is_admin, disabled: !!r.disabled, has_gmail: !!r.gmail_email };
}
router7.get("/users", async (c) => {
  const db = await getDb();
  const rows = (await db.execute(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC`)).rows;
  return c.json(rows.map(shapeUser));
});
router7.post("/users", async (c) => {
  try {
    const data = createUserSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.email.toLowerCase().trim();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt2.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash, is_admin, gmail_email, gmail_app_password) VALUES (?, ?, ?, ?, ?, ?)",
      args: [
        data.name?.trim() || null,
        email,
        hash,
        data.is_admin ? 1 : 0,
        data.gmail_email?.trim() || null,
        data.gmail_app_password?.trim() || null
      ]
    });
    const userId = Number(result.lastInsertRowid);
    const user = (await db.execute({ sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, args: [userId] })).rows[0];
    const gmailEmail = data.gmail_email?.trim();
    const gmailAppPassword = data.gmail_app_password?.trim();
    const sync = gmailEmail && gmailAppPassword ? await syncInboxNow(db, userId, gmailEmail, gmailAppPassword) : null;
    return c.json({ ...shapeUser(user), first_sync: sync });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router7.post("/users/:id/email-credentials", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = updateEmailCredsSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.gmail_email?.trim() || "";
    if (!email) {
      await db.execute({ sql: "UPDATE users SET gmail_email = NULL, gmail_app_password = NULL WHERE id = ?", args: [id] });
      return c.json({ success: true });
    }
    const appPassword = data.gmail_app_password?.trim() || "";
    if (appPassword) {
      await db.execute({
        sql: "UPDATE users SET gmail_email = ?, gmail_app_password = ? WHERE id = ?",
        args: [email, appPassword, id]
      });
      const sync = await syncInboxNow(db, id, email, appPassword);
      return c.json({ success: true, first_sync: sync });
    } else {
      await db.execute({ sql: "UPDATE users SET gmail_email = ? WHERE id = ?", args: [email, id] });
    }
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router7.delete("/users/:id", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot delete your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] });
  return c.json({ success: true });
});
router7.post("/users/:id/disable", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot disable your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 1 WHERE id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true });
});
router7.post("/users/:id/enable", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 0 WHERE id = ?", args: [id] });
  return c.json({ success: true });
});
router7.post("/users/:id/reset-password", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = resetPasswordSchema.parse(await c.req.json());
    const db = await getDb();
    const hash = await bcrypt2.hash(data.password, 10);
    await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router7.post("/users/:id/generate-password", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  const password = generateToken().slice(0, 12);
  const hash = await bcrypt2.hash(password, 10);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true, password });
});
var admin_default = router7;

// src/index.ts
var extraOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
var app = new Hono8();
app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://www.gradleadai.com",
    "https://gradleadai.com",
    ...extraOrigins
  ],
  credentials: true
}));
app.route("/api/auth", auth_default);
app.route("/api/leads", leads_default);
app.route("/api/messages", messages_default);
app.route("/api/ai", ai_default);
app.route("/api/conversations", conversations_default);
app.route("/api/webhooks/whatsapp", whatsapp_webhook_default);
app.route("/api/admin", admin_default);
app.get("/api/health", (c) => c.json({ status: "ok" }));
app.onError((err, c) => {
  console.error("[onError]", err);
  return c.json({ error: "Internal Server Error" }, 500);
});
var index_default = app;
if (process.env.NODE_ENV !== "production") {
  const port = parseInt(process.env.PORT ?? "3001");
  console.log(`Backend running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
} else {
  console.log("GradLeadAI backend in serverless mode \u2014 no listener started.");
}

// src/vercel.ts
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : void 0));
    req.on("error", reject);
  });
}
async function toWebRequest(req) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === void 0) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }
  return new Request(url, { method: req.method ?? "GET", headers, body });
}
async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}
async function handler(req, res) {
  try {
    const response = await index_default.fetch(await toWebRequest(req));
    await sendNodeResponse(res, response);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
export {
  handler as default
};
