import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Keeps tool calls off the network; the test is about how the app wires tools to the limiter
vi.mock("../analytics-api.js", () => ({
  listReports: vi.fn().mockResolvedValue({ EATime: "Month & Year" }),
  getReportInfo: vi.fn(),
  getReportMetadata: vi.fn(),
  getReportData: vi.fn(),
  pageviewsReportId: () => "EATime",
  conversionsReportId: () => "EAConversions",
  adReportId: () => "EAMedium",
}));

type Slot = { allowed: true; release: () => void } | { allowed: false; retryAfterMs: number };
const acquire = vi.fn((_partnerId: string): Slot => ({ allowed: true, release: () => {} }));
vi.mock("../ratelimit.js", () => ({ rateLimiter: { acquire: (partnerId: string) => acquire(partnerId) } }));

const { createApp } = await import("../app.js");
const { logger } = await import("../logger.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp(new Map([["key-a", "partner-a"], ["key-b", "partner-b"]]));
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function callTool(partnerKey: string, etrackerToken: string, name: string): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${partnerKey}.${etrackerToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
  expect(res.status).toBe(200);
  // Stateless StreamableHTTP answers with a single SSE "message" event
  const data = (await res.text()).split("\n").find((line) => line.startsWith("data: "))!;
  return JSON.parse(data.slice("data: ".length)).result;
}

describe("tool calls through the app", () => {
  it("acquires rate-limit slots for the authenticated partner ID, not the raw key", async () => {
    await callTool("key-b", "token-unique-1", "list_reports");
    expect(acquire).toHaveBeenCalledWith("partner-b");
    expect(acquire).not.toHaveBeenCalledWith("key-b");
  });

  it("logs a failing tool call with tool, partner and reason, and still returns isError", async () => {
    const warn = vi.spyOn(logger, "warn");
    acquire.mockReturnValueOnce({ allowed: false, retryAfterMs: 30_000 });

    const result = await callTool("key-a", "token-unique-2", "list_reports");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Rate limit exceeded");
    expect(warn).toHaveBeenCalledWith("tool call failed", {
      tool: "list_reports",
      partner: "partner-a",
      error: "Rate limit exceeded. Retry after 30s.",
    });
    warn.mockRestore();
  });
});
