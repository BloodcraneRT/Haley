/**
 * `npm run probe:psa -- <connection id or name>`: a read-only check of what a saved PSA connection returns,
 * printing field names, types and fill counts but never values. See docs/research/INTEGRATION_API_NOTES.md.
 */
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { probePsa } from "./psa/probe.js";
import { buildPsaAdapter } from "./psa/registry.js";
import { Store } from "./store.js";
import "./psa/autotask.js";
import "./psa/connectwise.js";
import "./psa/dynamics.js";
import "./psa/halopsa.js";
import "./psa/syncro.js";

const config = loadConfig();
const store = new Store(openDb(config.dbPath), config.secretKey);
const wanted = process.argv[2]?.trim();
const connections = store.listPsaConnections();
const connection = connections.find((c) => c.id === wanted || c.name.toLowerCase() === wanted?.toLowerCase());

if (!connection) {
  console.log(wanted ? `No PSA connection "${wanted}".` : "Usage: npm run probe:psa -- <connection id or name>");
  for (const c of connections) console.log(`  ${c.id}  ${c.kind.padEnd(12)} ${c.name}`);
  process.exit(wanted ? 1 : 0);
}

console.log(`Probing ${connection.name} (${connection.kind}). Read-only; values are never printed.\n`);
const steps = await probePsa(buildPsaAdapter(connection, store.getPsaConfig(connection.id)));
for (const s of steps) {
  console.log(`${s.ok ? "ok  " : "FAIL"} ${s.method} (${s.ms} ms): ${s.detail}`);
  for (const f of s.fields) console.log(`       ${f.field.padEnd(28)} ${f.types.join("|").padEnd(16)} filled ${f.filled}/${f.total}`);
}
process.exit(steps.every((s) => s.ok || s.detail.startsWith("Not supported")) ? 0 : 1);
