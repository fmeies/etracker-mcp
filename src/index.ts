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

// CORS — browser-based MCP clients (e.g. Claude Desktop) send a preflight
// OPTIONS request before attaching the Authorization header. Without this,
// the preflight hits authMiddleware, gets a 401 with no CORS headers, and
// the browser blocks the real request before it's ever sent.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

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

// Redact Authorization (carries both credentials) after auth has stored them
// in req.apiKey/req.etrackerToken, so it never appears in downstream logs
app.use((req: AuthenticatedRequest, _res, next) => {
  if (req.headers.authorization) req.headers.authorization = "[REDACTED]";
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

// ── /mcp endpoint (StreamableHTTP, stateless) ────────────────────────────────
//
// Every request gets a fresh transport + McpServer — no session ID, no SSE
// push, no server-side state to track. All of this project's tools are plain
// request/response calls into etracker's API, so there's nothing to gain from
// holding a connection open, and dropping it removes the need for session
// affinity when running multiple replicas.

app.post("/mcp", async (req: AuthenticatedRequest, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(req.etrackerToken!, req.apiKey!);
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed: this server is stateless, no SSE stream to subscribe to" });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed: this server is stateless, no session to close" });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info("server started", { port: PORT, mcp: "/mcp", health: "/health" });
});
