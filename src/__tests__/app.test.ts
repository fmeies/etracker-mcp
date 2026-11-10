import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp(new Map([["test-key", "partner-a"]]));
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const AUTH = { Authorization: "Bearer test-key.et-token" };
const MCP_HEADERS = { ...AUTH, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

async function mcpRequest(body: unknown) {
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
  const text = await res.text();
  // Stateless StreamableHTTP answers with a single SSE "message" event
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return { status: res.status, message: data ? JSON.parse(data.slice("data: ".length)) : undefined };
}

describe("HTTP app", () => {
  it("serves /health without authentication", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects /mcp without credentials", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("answers CORS preflights without credentials and allows the MCP protocol header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS", headers: { Origin: "https://client.example" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("returns a JSON-RPC parse error, not an HTML stack trace, for malformed JSON", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: MCP_HEADERS, body: "{bad" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
    expect(JSON.stringify(body)).not.toContain("node_modules");
  });

  it("rejects oversized bodies with a JSON 413", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST", headers: MCP_HEADERS, body: JSON.stringify({ padding: "x".repeat(200 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects unauthenticated requests before parsing the body", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it.each(["GET", "DELETE"])("returns 405 for %s /mcp on the stateless server", async (method) => {
    const res = await fetch(`${baseUrl}/mcp`, { method, headers: AUTH });
    expect(res.status).toBe(405);
  });

  it("handles initialize and tools/list without consuming etracker quota", async () => {
    const init = await mcpRequest({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    expect(init.message.result.serverInfo.name).toBe("etracker-mcp");
    expect(init.message.result.instructions).toContain("list_reports");

    // Far more protocol requests than the 8-per-10s burst limit: none may be rate limited
    const BURST_PLUS_MARGIN = 12;
    for (let i = 0; i < BURST_PLUS_MARGIN; i++) {
      const list = await mcpRequest({ jsonrpc: "2.0", id: i + 2, method: "tools/list" });
      expect(list.status).toBe(200);
      expect(list.message.result.tools.map((t: { name: string }) => t.name)).toContain("compare_periods");
    }
  });
});
