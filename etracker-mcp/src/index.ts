import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authMiddleware } from "./auth.js";
import type { AuthenticatedRequest } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import { createToolRegistrations } from "./tools.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// All MCP routes require auth + rate limiting
app.use(authMiddleware);
app.use((req: AuthenticatedRequest, res, next) => {
  const { allowed, retryAfterMs } = checkRateLimit(req.apiKey!);
  if (!allowed) {
    res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
    res.status(429).json({
      error: "Rate limit exceeded",
      retry_after_s: Math.ceil(retryAfterMs / 1000),
    });
    return;
  }
  next();
});

// ── MCP Server factory ────────────────────────────────────────────────────────

function createMcpServer(etrackerToken: string): McpServer {
  const server = new McpServer({ name: "etracker-mcp", version: "1.0.0" });
  for (const { name, description, schema, handler } of createToolRegistrations(etrackerToken)) {
    server.tool(name, description, schema, handler);
  }
  return server;
}

// ── Session store ─────────────────────────────────────────────────────────────

const sessions = new Map<string, StreamableHTTPServerTransport>();

// ── Single /mcp endpoint (StreamableHTTP) ────────────────────────────────────

app.all("/mcp", async (req: AuthenticatedRequest, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Existing session
  if (sessionId) {
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — only POST (initialize) is valid without a session ID
  if (req.method !== "POST") {
    res.status(400).json({ error: "Send POST to /mcp to start a session" });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = createMcpServer(req.etrackerToken!);
  await server.connect(transport);

  // handleRequest sends the response (including Mcp-Session-Id header)
  await transport.handleRequest(req, res, req.body);

  // Store after first request so we have the session ID
  if (transport.sessionId) {
    sessions.set(transport.sessionId, transport);
    console.log(`[${req.partnerId}] session opened: ${transport.sessionId}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`etracker MCP server running on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:   ALL /mcp`);
  console.log(`  Health check:   GET /health`);
});
