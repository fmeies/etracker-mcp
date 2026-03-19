/**
 * API Key authentication middleware.
 *
 * Two headers are required:
 *   X-Api-Key   — MCP server access key (maps to a partner ID, used for rate limiting)
 *   X-ET-Token  — etracker API token (forwarded directly to the etracker API)
 *
 * PARTNER_API_KEYS env var format:
 *   PARTNER_API_KEYS='{"key-abc":"partner-a","key-xyz":"partner-b"}'
 */

import type { Request, Response, NextFunction } from "express";

export interface AuthenticatedRequest extends Request {
  partnerId?: string;
  apiKey?: string;
  etrackerToken?: string;
}

function loadKeys(): Map<string, string> {
  const raw = process.env.PARTNER_API_KEYS;
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    console.error("PARTNER_API_KEYS is not valid JSON");
    return new Map();
  }
}

const KEYS = loadKeys();

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const apiKeyHeader = req.headers["x-api-key"];
  const key = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;

  if (!key || !KEYS.has(key)) {
    res.status(401).json({ error: "Unauthorized: invalid or missing X-Api-Key" });
    return;
  }

  const etHeader = req.headers["x-et-token"];
  const etToken = Array.isArray(etHeader) ? etHeader[0] : etHeader;

  if (!etToken) {
    res.status(401).json({ error: "Unauthorized: missing X-ET-Token" });
    return;
  }

  req.partnerId = KEYS.get(key)!;
  req.apiKey = key;
  req.etrackerToken = etToken;
  next();
}
