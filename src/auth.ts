/**
 * Authorization-header authentication middleware.
 *
 * One header carries both credentials:
 *   Authorization: Bearer <partnerKey>.<etrackerToken>
 *
 *   partnerKey    — MCP server access key (maps to a partner ID, used for rate limiting)
 *   etrackerToken — etracker API token (forwarded to the etracker API as X-ET-Token)
 *
 * Custom headers (even Anthropic-approved names like X-Api-Key) get silently
 * dropped by some MCP connector proxies before the request reaches us — only
 * Authorization is reliably forwarded everywhere, so both credentials are
 * packed into it instead of using two separate headers.
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
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  const separatorIndex = bearerToken?.indexOf(".") ?? -1;

  if (!bearerToken || separatorIndex === -1) {
    logger.warn("auth failed", { reason: "invalid or missing Authorization header", path: req.path });
    res.status(401).json({ error: "Unauthorized: expected Authorization: Bearer <partnerKey>.<etrackerToken>" });
    return;
  }

  const key = bearerToken.slice(0, separatorIndex);
  const etToken = bearerToken.slice(separatorIndex + 1);

  if (!KEYS.has(key)) {
    logger.warn("auth failed", { reason: "invalid partner key", path: req.path });
    res.status(401).json({ error: "Unauthorized: invalid partner key" });
    return;
  }

  if (!etToken) {
    logger.warn("auth failed", { reason: "missing et token", partner: KEYS.get(key), path: req.path });
    res.status(401).json({ error: "Unauthorized: missing etracker token" });
    return;
  }

  req.partnerId = KEYS.get(key)!;
  req.apiKey = key;
  req.etrackerToken = etToken;
  next();
}
