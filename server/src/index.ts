import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp({ config });

if (!config.apiToken) {
  console.warn("[haley] HALEY_API_TOKEN is not set; the API is open to anyone who can reach it. Set it before exposing Haley.");
}

await app.listen({ port: config.port, host: config.host });
console.log(`[haley] listening on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port} (model ${config.model})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
