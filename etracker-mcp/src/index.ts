import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authMiddleware } from "./auth.js";
import type { AuthenticatedRequest } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import { createToolRegistrations } from "./tools.js";
import { logger } from "./logger.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "100kb" }));

// Request logging — runs for every request including health and auth failures
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const authed = req as AuthenticatedRequest;
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      partner: authed.partnerId ?? "unauthenticated",
    });
  });
  next();
});

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// All MCP routes require auth + rate limiting
app.use(authMiddleware);

// Redact X-ET-Token after auth has stored it in req.etrackerToken,
// so it never appears in downstream logs or error output
app.use((req: AuthenticatedRequest, _res, next) => {
  if (req.headers["x-et-token"]) req.headers["x-et-token"] = "[REDACTED]";
  next();
});
app.use((req: AuthenticatedRequest, res, next) => {
  const { allowed, retryAfterMs } = checkRateLimit(req.apiKey!);
  if (!allowed) {
    const retryAfterS = Math.ceil(retryAfterMs / 1000);
    logger.warn("rate limit exceeded", { partner: req.partnerId, retry_after_s: retryAfterS });
    res.setHeader("Retry-After", retryAfterS.toString());
    res.status(429).json({ error: "Rate limit exceeded", retry_after_s: retryAfterS });
    return;
  }
  next();
});

// ── MCP Server factory ────────────────────────────────────────────────────────

function createMcpServer(etrackerToken: string, apiKey: string): McpServer {
  const server = new McpServer({ name: "etracker-mcp", version: "1.0.0" });
  for (const { name, description, schema, handler } of createToolRegistrations(etrackerToken, () => checkRateLimit(apiKey))) {
    server.tool(name, description, schema, handler);
  }
  return server;
}

// ── Session store ─────────────────────────────────────────────────────────────

const MAX_SESSIONS = 500;
const SESSION_TTL_MS = 60 * 60_000; // 1 hour

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  expiresAt: number;
}

const sessions = new Map<string, SessionEntry>();
let pendingSessions = 0;

// Periodically evict expired sessions to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [id, entry] of sessions) {
    if (now >= entry.expiresAt) { sessions.delete(id); evicted++; }
  }
  if (evicted > 0) logger.debug("sessions evicted", { count: evicted });
}, 5 * 60_000);

// ── Single /mcp endpoint (StreamableHTTP) ────────────────────────────────────

app.all("/mcp", async (req: AuthenticatedRequest, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || Date.now() >= entry.expiresAt) {
      if (entry) sessions.delete(sessionId);
      logger.debug("session not found or expired", { session: sessionId });
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    entry.expiresAt = Date.now() + SESSION_TTL_MS; // refresh TTL on activity
    await entry.transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — only POST (initialize) is valid without a session ID
  if (req.method !== "POST") {
    res.status(400).json({ error: "Send POST to /mcp to start a session" });
    return;
  }

  // Reserve slot synchronously to prevent TOCTOU race at capacity boundary
  if (sessions.size + pendingSessions >= MAX_SESSIONS) {
    logger.warn("session capacity reached", { current: sessions.size });
    res.status(503).json({ error: "Server at session capacity, try again later" });
    return;
  }
  pendingSessions++;

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.debug("session closed", { session: transport.sessionId });
      }
    };

    const server = createMcpServer(req.etrackerToken!, req.apiKey!);
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);

    // Store after first request so we have the session ID
    if (transport.sessionId) {
      sessions.set(transport.sessionId, { transport, expiresAt: Date.now() + SESSION_TTL_MS });
      logger.info("session opened", { partner: req.partnerId, session: transport.sessionId });
    }
  } finally {
    pendingSessions--;
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info("server started", { port: PORT, mcp: "/mcp", health: "/health" });
});
