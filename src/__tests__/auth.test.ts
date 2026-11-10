import type { NextFunction, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware, parsePartnerKeys, type AuthenticatedRequest } from "../auth.js";

function mockReq(headers: Record<string, string>): AuthenticatedRequest {
  return { headers } as AuthenticatedRequest;
}

function mockRes() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  return res as unknown as Response;
}

const authMiddleware = createAuthMiddleware(new Map([["test-key", "partner-a"]]));

function authenticate(authorization?: string) {
  const req = mockReq(authorization === undefined ? {} : { authorization });
  const res = mockRes();
  const next = vi.fn();
  authMiddleware(req, res, next as NextFunction);
  return { req, res, next };
}

describe("authMiddleware", () => {
  it.each([
    ["no Authorization header", undefined],
    ["no Bearer prefix", "test-key.et-abc123"],
    ["no separator", "Bearer test-key"],
    ["an unknown partner key", "Bearer wrong-key.et-abc123"],
    ["a missing etracker token", "Bearer test-key."],
  ])("rejects a request with %s", (_case, authorization) => {
    const { res, next } = authenticate(authorization);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() and populates req fields on a valid request", () => {
    const { req, next } = authenticate("Bearer test-key.et-abc123");
    expect(next).toHaveBeenCalledOnce();
    expect(req.partnerId).toBe("partner-a");
    expect(req.etrackerToken).toBe("et-abc123");
  });

  it("accepts the Bearer scheme case-insensitively", () => {
    const { req, next } = authenticate("bearer test-key.et-abc123");
    expect(next).toHaveBeenCalledOnce();
    expect(req.partnerId).toBe("partner-a");
  });

  it("keeps dots inside the etracker token, splitting only at the first one", () => {
    const { req } = authenticate("Bearer test-key.part1.part2.part3");
    expect(req.etrackerToken).toBe("part1.part2.part3");
  });
});

describe("parsePartnerKeys", () => {
  it("parses a key → partner map", () => {
    expect(parsePartnerKeys('{"key-a":"partner-a"}').get("key-a")).toBe("partner-a");
  });

  it.each([
    ["is unset", undefined, "not set"],
    ["is blank", "  ", "not set"],
    ["is not JSON", "{oops", "not valid JSON"],
    ["is an array", '["key"]', "must be a JSON object"],
    ["is empty", "{}", "contains no keys"],
    ["has a key containing the separator", '{"key.a":"partner-a"}', 'must not contain "."'],
    ["has a non-string partner ID", '{"key-a":42}', "non-empty partner ID strings"],
    ["has an empty partner ID", '{"key-a":""}', "non-empty partner ID strings"],
  ])("throws when PARTNER_API_KEYS %s", (_case, raw, message) => {
    expect(() => parsePartnerKeys(raw)).toThrow(message);
  });
});
