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

const acquire = vi.fn((_partnerId: string) => ({ allowed: true as const, release: () => {} }));
vi.mock("../ratelimit.js", () => ({ rateLimiter: { acquire: (partnerId: string) => acquire(partnerId) } }));

const { createApp } = await import("../app.js");

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

async function callTool(partnerKey: string, etrackerToken: string, name: string) {
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
}

describe("tool calls through the app", () => {
  it("acquires rate-limit slots for the authenticated partner ID, not the raw key", async () => {
    await callTool("key-b", "token-unique-1", "list_reports");
    expect(acquire).toHaveBeenCalledWith("partner-b");
    expect(acquire).not.toHaveBeenCalledWith("key-b");
  });
});
