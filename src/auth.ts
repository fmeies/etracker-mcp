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

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { logger } from "./logger.js";

export interface AuthenticatedRequest extends Request {
  partnerId?: string;
  etrackerToken?: string;
}

export type PartnerKeys = ReadonlyMap<string, string>;

const CREDENTIAL_SEPARATOR = ".";
// RFC 7235: the auth scheme name is case-insensitive
const BEARER_PREFIX = /^bearer\s+/i;

/** Parses PARTNER_API_KEYS; throws so a misconfigured server never starts. */
export function parsePartnerKeys(raw: string | undefined): PartnerKeys {
  if (!raw?.trim()) {
    throw new Error("PARTNER_API_KEYS is not set. Expected a JSON object like {\"<key>\":\"<partner-id>\"}.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PARTNER_API_KEYS is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PARTNER_API_KEYS must be a JSON object mapping keys to partner IDs.");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error("PARTNER_API_KEYS contains no keys.");

  for (const [key, partnerId] of entries) {
    if (!key) throw new Error("PARTNER_API_KEYS contains an empty key.");
    if (key.includes(CREDENTIAL_SEPARATOR)) {
      // The key is split from the etracker token at the first separator
      throw new Error(`PARTNER_API_KEYS key for partner "${String(partnerId)}" must not contain "${CREDENTIAL_SEPARATOR}".`);
    }
    if (typeof partnerId !== "string" || !partnerId) {
      throw new Error("PARTNER_API_KEYS values must be non-empty partner ID strings.");
    }
  }
  return new Map(entries as Array<[string, string]>);
}

function reject(res: Response, reason: string, message: string, path: string): void {
  logger.warn("auth failed", { reason, path });
  res.setHeader("WWW-Authenticate", 'Bearer realm="etracker-mcp"');
  res.status(401).json({ error: `Unauthorized: ${message}` });
}

export function createAuthMiddleware(keys: PartnerKeys): RequestHandler {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization ?? "";
    const prefix = BEARER_PREFIX.exec(authHeader);
    const credentials = prefix ? authHeader.slice(prefix[0].length) : "";
    const separatorIndex = credentials.indexOf(CREDENTIAL_SEPARATOR);

    if (!credentials || separatorIndex === -1) {
      reject(res, "invalid or missing Authorization header", "expected Authorization: Bearer <partnerKey>.<etrackerToken>", req.path);
      return;
    }

    const partnerId = keys.get(credentials.slice(0, separatorIndex));
    const etrackerToken = credentials.slice(separatorIndex + 1);

    if (!partnerId) {
      reject(res, "invalid partner key", "invalid partner key", req.path);
      return;
    }
    if (!etrackerToken) {
      reject(res, "missing et token", "missing etracker token", req.path);
      return;
    }

    req.partnerId = partnerId;
    req.etrackerToken = etrackerToken;
    next();
  };
}
