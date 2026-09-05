import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

async function setup() {
  console.log("Connecting to Turso database...");

  // Create users table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log("✓ users table created");

  // Create sessions table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  console.log("✓ sessions table created");

  // Create leads table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
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
    )
  `);
  console.log("✓ leads table created");

  // Create email_messages table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS email_messages (
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
    )
  `);
  console.log("✓ email_messages table created");

  // Create whatsapp_messages table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      body TEXT,
      status TEXT DEFAULT 'draft',
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )
  `);
  console.log("✓ whatsapp_messages table created");

  // Create call_logs table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS call_logs (
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
    )
  `);
  console.log("✓ call_logs table created");

  // Create appointments table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      call_id TEXT,
      title TEXT,
      scheduled_at TEXT,
      duration_min INTEGER DEFAULT 30,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )
  `);
  console.log("✓ appointments table created");

  // Create chat_messages table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      citations TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log("✓ chat_messages table created");

  // Seed demo user
  const hash = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
  await client.execute({
    sql: "INSERT OR IGNORE INTO users (name, email, password_hash) VALUES (?, ?, ?)",
    args: ["Test User", "testuser@gmail.com", hash],
  });
  console.log("✓ demo user seeded");

  // Verify by listing tables
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log("\nTables in database:");
  for (const row of tables.rows) {
    console.log(`  - ${row.name}`);
  }

  console.log("\n✅ Database setup complete!");
}

setup().catch((err) => {
  console.error("❌ Setup failed:", err);
  process.exit(1);
});