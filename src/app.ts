import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuthMiddleware, type AuthenticatedRequest, type PartnerKeys } from "./auth.js";
import { rateLimiter } from "./ratelimit.js";
import { createToolRegistrations, SERVER_INSTRUCTIONS, type ToolRegistration } from "./tools.js";
import { logger } from "./logger.js";

const MAX_BODY_SIZE = "100kb";
const SERVER_INFO = { name: "etracker-mcp", version: "1.0.0" };

// MCP-Protocol-Version is sent by spec-compliant clients on every request after initialize
const CORS_ALLOWED_HEADERS = "Content-Type, Accept, Authorization, MCP-Protocol-Version";
const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
// Lets browsers reuse a preflight for 10 minutes instead of repeating it per request
const CORS_MAX_AGE_SECONDS = "600";

// JSON-RPC 2.0 error codes
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INTERNAL_ERROR = -32603;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;

// Browser-based MCP clients send a preflight OPTIONS request without the
// Authorization header; it must be answered before authMiddleware rejects it.
// Reflecting any origin is safe because credentials travel in a bearer header, not cookies.
const cors: RequestHandler = (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  res.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS);
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

// The SDK turns handler exceptions into isError results without logging them
function withFailureLogging(tool: ToolRegistration, partnerId: string): ToolRegistration["handler"] {
  return async (input) => {
    try {
      return await tool.handler(input);
    } catch (error) {
      logger.warn("tool call failed", {
        tool: tool.name,
        partner: partnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function createMcpServer(etrackerToken: string, partnerId: string): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  // Rate limiting happens per etracker API call inside the tools, not per HTTP request,
  // so MCP protocol traffic (initialize, tools/list) and cache hits never use quota
  const tools = createToolRegistrations(etrackerToken, () => rateLimiter.acquire(partnerId));
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, withFailureLogging(tool, partnerId));
  }
  return server;
}

function isBodyParserError(error: unknown): error is { type: string; status: number; message: string } {
  return typeof error === "object" && error !== null && "type" in error && "status" in error;
}

// Answers every error as JSON-RPC instead of Express's default HTML page with a stack trace
const jsonErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (isBodyParserError(error)) {
    const parseFailed = error.type === "entity.parse.failed";
    logger.warn("invalid request body", { path: req.path, type: error.type });
    res.status(parseFailed ? HTTP_BAD_REQUEST : error.status).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSON_RPC_PARSE_ERROR, message: parseFailed ? "Parse error: invalid JSON" : error.message },
    });
    return;
  }
  logger.error("unhandled request error", { path: req.path, error: error instanceof Error ? error.message : String(error) });
  if (res.headersSent) return;
  res.status(HTTP_INTERNAL_ERROR).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: JSON_RPC_INTERNAL_ERROR, message: "Internal server error" },
  });
};

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
  // Don't advertise the framework to scanners
  app.disable("x-powered-by");
  app.use(cors);
  app.use(requestLogger);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createAuthMiddleware(partnerKeys));
  app.use(redactAuthorization);
  // Parsed only after auth, so unauthenticated clients can't make the server parse bodies
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed: this server is stateless, no SSE stream to subscribe to" });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed: this server is stateless, no session to close" });
  });

  app.use(jsonErrorHandler);

  return app;
}
