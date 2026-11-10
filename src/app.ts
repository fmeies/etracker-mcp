import express, { type Express, type RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuthMiddleware, type AuthenticatedRequest, type PartnerKeys } from "./auth.js";
import { checkRateLimit } from "./ratelimit.js";
import { createToolRegistrations } from "./tools.js";
import { logger } from "./logger.js";

const MAX_BODY_SIZE = "100kb";
const SERVER_INFO = { name: "etracker-mcp", version: "1.0.0" };

// MCP-Protocol-Version is sent by spec-compliant clients on every request after initialize
const CORS_ALLOWED_HEADERS = "Content-Type, Accept, Authorization, MCP-Protocol-Version";
const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";

// Browser-based MCP clients send a preflight OPTIONS request without the
// Authorization header; it must be answered before authMiddleware rejects it.
// Reflecting any origin is safe because credentials travel in a bearer header, not cookies.
const cors: RequestHandler = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
};

const requestLogger: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info("request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      partner: (req as AuthenticatedRequest).partnerId ?? "unauthenticated",
    });
  });
  next();
};

// Authorization carries both credentials; auth has copied them onto req by now
const redactAuthorization: RequestHandler = (req, _res, next) => {
  if (req.headers.authorization) req.headers.authorization = "[REDACTED]";
  next();
};

function createMcpServer(etrackerToken: string, partnerId: string): McpServer {
  const server = new McpServer(SERVER_INFO);
  // Rate limiting happens per etracker API call inside the tools, not per HTTP request,
  // so MCP protocol traffic (initialize, tools/list) and cache hits never use quota
  const tools = createToolRegistrations(etrackerToken, () => checkRateLimit(partnerId));
  for (const { name, description, schema, handler } of tools) {
    server.registerTool(name, { description, inputSchema: schema }, handler);
  }
  return server;
}

// Stateless StreamableHTTP: every request gets a fresh transport + McpServer, so any
// replica can serve any request and no session state needs tracking or eviction.
const handleMcpRequest: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(req.etrackerToken!, req.partnerId!);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

export function createApp(partnerKeys: PartnerKeys): Express {
  const app = express();
  app.use(express.json({ limit: MAX_BODY_SIZE }));
  app.use(cors);
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthMiddleware(partnerKeys));
  app.use(redactAuthorization);

  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed: this server is stateless, no SSE stream to subscribe to" });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed: this server is stateless, no session to close" });
  });

  return app;
}
