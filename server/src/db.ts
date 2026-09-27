import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  autonomy TEXT NOT NULL DEFAULT 'supervised',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  mode TEXT NOT NULL,
  config_sealed TEXT,
  state TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (org_id, provider)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requester_name TEXT NOT NULL DEFAULT '',
  requester_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  category TEXT NOT NULL DEFAULT 'uncategorized',
  assignee TEXT NOT NULL DEFAULT 'haley',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  messages TEXT NOT NULL DEFAULT '[]',
  pending TEXT,
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  iterations INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  risk TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  result TEXT,
  secrets_sealed TEXT,
  decided_by TEXT,
  decision_note TEXT,
  decided_at TEXT,
  executed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_org ON tickets(org_id, status);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
`;

export type Db = DatabaseSync;

/** Forward-only migrations, applied in order and tracked with PRAGMA user_version. */
const MIGRATIONS: string[] = [
  // 1: end-user channels, verified identity, per-org self-service settings
  `ALTER TABLE orgs ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE tickets ADD COLUMN channel TEXT NOT NULL DEFAULT 'portal';
   ALTER TABLE tickets ADD COLUMN channel_ref TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE tickets ADD COLUMN assurance TEXT NOT NULL DEFAULT 'none';
   ALTER TABLE tickets ADD COLUMN verification TEXT NOT NULL DEFAULT '';
   ALTER TABLE tickets ADD COLUMN needs_followup INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE actions ADD COLUMN policy_reason TEXT NOT NULL DEFAULT '';
   ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';
   CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(channel, requester_email, status);`,
  // 2: schedules and SLA timestamps
  `CREATE TABLE IF NOT EXISTS schedules (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     instruction TEXT NOT NULL,
     cadence TEXT NOT NULL,
     mode TEXT NOT NULL DEFAULT 'live',
     next_run_at TEXT,
     last_run_at TEXT,
     last_run_id TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
   ALTER TABLE tickets ADD COLUMN first_response_at TEXT;
   ALTER TABLE tickets ADD COLUMN resolved_at TEXT;
   ALTER TABLE tickets ADD COLUMN sla_escalated INTEGER NOT NULL DEFAULT 0;`,
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return db;
}

/** Runs fn inside a transaction; rolls back on throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
