import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface HaleyConfig {
  port: number;
  host: string;
  dbPath: string;
  /** 32-byte key (hex or base64) used to encrypt integration credentials at rest. */
  secretKey: Buffer;
  /** Bearer token required on every /api request. Empty string disables auth (dev only). */
  apiToken: string;
  model: string;
  /** Opt into server-side refusal fallbacks on the Claude API. */
  fallbacks: boolean;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxAgentIterations: number;
  webDist: string | null;
  production: boolean;
}

function parseKey(raw: string | undefined, production: boolean, dbPath: string): Buffer {
  if (!raw) {
    if (production) {
      throw new Error("HALEY_SECRET_KEY is required in production (32 bytes, hex or base64).");
    }
    if (dbPath === ":memory:") return randomBytes(32);
    // Dev convenience: generate a key once and keep it beside the database.
    const keyFile = `${dbPath}.key`;
    if (!existsSync(keyFile)) {
      writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
      console.warn(`[haley] HALEY_SECRET_KEY not set; generated a development key at ${keyFile}.`);
    }
    raw = readFileSync(keyFile, "utf8").trim();
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("HALEY_SECRET_KEY must decode to exactly 32 bytes.");
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HaleyConfig {
  const production = env.NODE_ENV === "production";
  const apiToken = env.HALEY_API_TOKEN ?? "";
  if (production && !apiToken) {
    throw new Error("HALEY_API_TOKEN is required in production.");
  }
  const effort = (env.HALEY_EFFORT ?? "high") as HaleyConfig["effort"];
  const dbPath = env.HALEY_DB_PATH ?? "haley.db";
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    dbPath,
    secretKey: parseKey(env.HALEY_SECRET_KEY, production, dbPath),
    apiToken,
    model: env.HALEY_MODEL ?? "claude-opus-5",
    fallbacks: (env.HALEY_FALLBACKS ?? "on") !== "off",
    effort,
    maxAgentIterations: Number(env.HALEY_MAX_ITERATIONS ?? 30),
    // Built dashboard; from src/ or dist/ this resolves to <repo>/web/dist.
    webDist: env.HALEY_WEB_DIST ?? join(import.meta.dirname, "../../web/dist"),
    production,
  };
}
