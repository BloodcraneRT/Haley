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
  // 3: provider-agnostic AI models
  `CREATE TABLE IF NOT EXISTS model_profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     base_url TEXT NOT NULL DEFAULT '',
     api_key_sealed TEXT,
     options TEXT NOT NULL DEFAULT '{}',
     fallback_id TEXT,
     is_default INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   ALTER TABLE runs ADD COLUMN model TEXT NOT NULL DEFAULT '';`,
  // 4: MFA step-up verification and one-time secret links
  `ALTER TABLE tickets ADD COLUMN mfa_verified_at TEXT;
   ALTER TABLE tickets ADD COLUMN mfa_method TEXT NOT NULL DEFAULT '';
   CREATE TABLE IF NOT EXISTS verification_attempts (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
     method TEXT NOT NULL,
     target TEXT NOT NULL,
     outcome TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_verification_target ON verification_attempts(target, created_at);
   CREATE TABLE IF NOT EXISTS secret_links (
     token_hash TEXT PRIMARY KEY,
     action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
     ticket_id TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     viewed_at TEXT,
     created_at TEXT NOT NULL
   );`,
  // 5: PSA / service desk sync (SyncroMSP, Dynamics 365)
  `CREATE TABLE IF NOT EXISTS psa_connections (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT NOT NULL,
     config_sealed TEXT NOT NULL,
     customer_map TEXT NOT NULL DEFAULT '{}',
     options TEXT NOT NULL DEFAULT '{}',
     cursor TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'unknown',
     status_detail TEXT NOT NULL DEFAULT '',
     last_sync_at TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS ticket_links (
     ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     connection_id TEXT NOT NULL REFERENCES psa_connections(id) ON DELETE CASCADE,
     external_id TEXT NOT NULL,
     external_number TEXT NOT NULL DEFAULT '',
     seen_comment_ids TEXT NOT NULL DEFAULT '[]',
     pushed_event_ids TEXT NOT NULL DEFAULT '[]',
     last_status TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     PRIMARY KEY (ticket_id, connection_id),
     UNIQUE (connection_id, external_id)
   );`,
  // 6: client policy rules can route an approval to named technicians; Microsoft 365 tenant discovery
  `ALTER TABLE actions ADD COLUMN approvers TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE IF NOT EXISTS tenant_discoveries (
     integration_id TEXT PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  // 7: per-client memory: short facts Haley learns about a client's environment
  `CREATE TABLE IF NOT EXISTS client_memories (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     status TEXT NOT NULL,
     source TEXT NOT NULL,
     run_id TEXT,
     ticket_id TEXT,
     created_by TEXT NOT NULL,
     reviewed_by TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_client_memories_org ON client_memories(org_id, status);`,
  // 8: billing metrics: model usage per call, the recipe a run came from, confirmed resolutions, workspace settings
  `CREATE TABLE IF NOT EXISTS model_usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_model_usage_org ON model_usage(org_id, created_at);
   ALTER TABLE runs ADD COLUMN template_id TEXT;
   ALTER TABLE tickets ADD COLUMN resolution_confirmed_at TEXT;
   CREATE TABLE IF NOT EXISTS workspace_settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // 9: preserve recipe attribution when recurring tasks fire
  `ALTER TABLE schedules ADD COLUMN template_id TEXT;`,
  // 10: Haley's work logged as PSA time entries
  `ALTER TABLE ticket_links ADD COLUMN logged_time TEXT NOT NULL DEFAULT '[]';`,
  // 11: incidents: several tickets about one shared problem (a likely outage)
  `CREATE TABLE IF NOT EXISTS incidents (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     resolved_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_incidents_org ON incidents(org_id, status);
   ALTER TABLE tickets ADD COLUMN incident_id TEXT REFERENCES incidents(id) ON DELETE SET NULL;
   CREATE INDEX IF NOT EXISTS idx_tickets_incident ON tickets(incident_id);`,
  // 12: model calls outside runs (the technician copilot) are billed too: run_id becomes optional
  `CREATE TABLE model_usage_v12 (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     purpose TEXT NOT NULL DEFAULT 'run'
   );
   INSERT INTO model_usage_v12 (id, run_id, org_id, model, input_tokens, output_tokens, created_at)
     SELECT id, run_id, org_id, model, input_tokens, output_tokens, created_at FROM model_usage;
   DROP TABLE model_usage;
   ALTER TABLE model_usage_v12 RENAME TO model_usage;
   CREATE INDEX IF NOT EXISTS idx_model_usage_org ON model_usage(org_id, created_at);
   CREATE INDEX IF NOT EXISTS idx_model_usage_run ON model_usage(run_id);`,
  // 13: technician directory: who the MSP's technicians are, and their Slack and Teams identities
  `CREATE TABLE IF NOT EXISTS technicians (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     email TEXT,
     slack_user_id TEXT,
     teams_aad_id TEXT,
     psa_refs TEXT NOT NULL DEFAULT '{}',
     working_hours TEXT,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_email ON technicians(email COLLATE NOCASE) WHERE email IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_slack ON technicians(slack_user_id) WHERE slack_user_id IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_technicians_teams ON technicians(teams_aad_id) WHERE teams_aad_id IS NOT NULL;`,
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
