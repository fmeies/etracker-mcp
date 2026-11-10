import { createApp } from "./app.js";
import { parsePartnerKeys } from "./auth.js";
import { logger } from "./logger.js";

const DEFAULT_PORT = 3000;
// Kubernetes waits 30 s by default before SIGKILL; finish in-flight requests well before that
const SHUTDOWN_TIMEOUT_MS = 20_000;

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT "${raw}". Expected an integer between 1 and 65535.`);
  }
  return port;
}

const port = parsePort(process.env.PORT);
const app = createApp(parsePartnerKeys(process.env.PARTNER_API_KEYS));

const server = app.listen(port, () => {
  logger.info("server started", { port, mcp: "/mcp", health: "/health" });
});

function shutdown(signal: string): void {
  logger.info("shutting down", { signal });
  server.close((error) => {
    if (error) {
      logger.error("shutdown failed", { error: error.message });
      process.exit(1);
    }
    process.exit(0);
  });
  setTimeout(() => {
    logger.error("shutdown timed out, forcing exit", { timeout_ms: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
