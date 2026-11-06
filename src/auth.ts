/**
 * API Key authentication middleware.
 *
 * Two headers are required:
 *   X-Auth-Token — MCP server access key (maps to a partner ID, used for rate limiting)
 *   X-Api-Key    — etracker API token (forwarded to the etracker API as X-ET-Token)
 *
 * Header names deliberately avoid etracker-specific terms (e.g. X-ET-Token) because
 * Claude's remote MCP connector UI only allows custom header names from an Anthropic-
 * approved allowlist; generic names like X-Auth-Token/X-Api-Key clear that check.
 *
 * PARTNER_API_KEYS env var format:
 *   PARTNER_API_KEYS='{"key-abc":"partner-a","key-xyz":"partner-b"}'
 */

import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

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
    logger.error("PARTNER_API_KEYS is not valid JSON");
    return new Map();
  }
}

const KEYS = loadKeys();

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const partnerKeyHeader = req.headers["x-auth-token"];
  const key = Array.isArray(partnerKeyHeader) ? partnerKeyHeader[0] : partnerKeyHeader;

  if (!key || !KEYS.has(key)) {
    logger.warn("auth failed", { reason: "invalid or missing partner key", path: req.path });
    res.status(401).json({ error: "Unauthorized: invalid or missing X-Auth-Token" });
    return;
  }

  const etHeader = req.headers["x-api-key"];
  const etToken = Array.isArray(etHeader) ? etHeader[0] : etHeader;

  if (!etToken) {
    logger.warn("auth failed", { reason: "missing et token", partner: KEYS.get(key), path: req.path });
    res.status(401).json({ error: "Unauthorized: missing X-Api-Key" });
    return;
  }

  req.partnerId = KEYS.get(key)!;
  req.apiKey = key;
  req.etrackerToken = etToken;
  next();
}
