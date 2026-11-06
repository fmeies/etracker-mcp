import type { NextFunction, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequest } from "../auth.js";

// Helpers ────────────────────────────────────────────────────────────────────

function mockReq(headers: Record<string, string>): AuthenticatedRequest {
  return { headers } as AuthenticatedRequest;
}

function mockRes() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return res as unknown as Response;
}

// Each test reloads auth.ts so PARTNER_API_KEYS is re-read from the env.
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("PARTNER_API_KEYS", JSON.stringify({ "test-key": "partner-a" }));
});
afterEach(() => vi.unstubAllEnvs());

// Tests ──────────────────────────────────────────────────────────────────────

describe("authMiddleware", () => {
  it("rejects a request with no X-Auth-Token header", async () => {
    const { authMiddleware } = await import("../auth.js");
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(mockReq({}), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a request with an unknown X-Auth-Token", async () => {
    const { authMiddleware } = await import("../auth.js");
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(mockReq({ "x-auth-token": "wrong-key" }), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a request with a valid X-Auth-Token but missing X-Api-Key", async () => {
    const { authMiddleware } = await import("../auth.js");
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(mockReq({ "x-auth-token": "test-key" }), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and populates req fields on a valid request", async () => {
    const { authMiddleware } = await import("../auth.js");
    const req = mockReq({ "x-auth-token": "test-key", "x-api-key": "et-abc123" });
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(req, res, next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
    expect(req.partnerId).toBe("partner-a");
    expect(req.apiKey).toBe("test-key");
    expect(req.etrackerToken).toBe("et-abc123");
  });

  it("works with no PARTNER_API_KEYS configured (rejects everything)", async () => {
    vi.stubEnv("PARTNER_API_KEYS", "");
    const { authMiddleware } = await import("../auth.js");
    const res = mockRes();
    const next = vi.fn();
    authMiddleware(mockReq({ "x-auth-token": "test-key", "x-api-key": "et-abc" }), res, next as NextFunction);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
