/**
 * etracker Reporting API client
 * Docs: https://docs.etracker.com/api/report.html
 *
 * Optional env vars (report IDs — override defaults per account):
 *   ETRACKER_REPORT_PAGEVIEWS    (default: EATime)
 *   ETRACKER_REPORT_CONVERSIONS  (default: EAConversions)
 *   ETRACKER_REPORT_AD           (default: EAMedium — marketing channels)
 *
 * The etracker account token is not stored here — it is passed per request
 * via the X-ET-Token header and forwarded directly to the API.
 */

import { logger } from "./logger.js";

const BASE_URL = "https://ws.etracker.com/api/v7";
const FETCH_TIMEOUT_MS = 10_000;
// Enough to show etracker's error message without echoing arbitrary upstream payloads
const MAX_ERROR_BODY_CHARS = 500;

// etracker reports most client errors as HTTP 400 with an errorCode in the JSON body
const ERROR_HINTS: Record<string, string> = {
  "1012": "Report not found or not available via the API. Call list_reports to see valid report IDs.",
  "9000": "The etracker token is invalid. Check the token in your connector's Authorization header (it needs the \"Reporting API\" scope).",
};
const AUTH_ERROR_HINT =
  "etracker rejected the token. It must be an etracker Enterprise access token with the \"Reporting API\" scope.";

function errorHint(status: number, body: string): string | undefined {
  try {
    const code = String((JSON.parse(body) as { errorCode?: unknown }).errorCode);
    if (ERROR_HINTS[code]) return ERROR_HINTS[code];
  } catch {
    // Non-JSON error bodies carry no errorCode; fall through to the status-based hint
  }
  return status === 401 || status === 403 ? AUTH_ERROR_HINT : undefined;
}

async function etrackerFetch<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const start = Date.now();
  logger.debug("etracker api call", { path });

  const res = await fetch(url.toString(), {
    headers: {
      "X-ET-Token": token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
    logger.error("etracker api error", { path, status: res.status, duration_ms: Date.now() - start });
    const hint = errorHint(res.status, body);
    throw new Error(`etracker API error ${res.status}${hint ? ` — ${hint}` : ""} Details: ${body}`);
  }

  logger.debug("etracker api response", { path, status: res.status, duration_ms: Date.now() - start });
  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

/** Report ID → label, e.g. { EAPage: "Pages", EATime: "Month & Year" } */
export type ReportList = Record<string, string>;

export interface ReportColumn {
  id: string;
  label: string;
  type: string;
  sortable: boolean;
  filterable: boolean;
}

export interface ReportAttribute {
  id: string;
  label: string;
  type: string;
  sortable: boolean;
  filterable: boolean;
  common_attribute?: boolean;
}

export interface ReportFigure {
  id: string;
  label: string;
  type: string;
  sortable: boolean;
  filterable: boolean;
  visible: boolean;
  deprecated: boolean;
  recommended: boolean;
  groupLabel?: string;
}

export interface ReportInfoResponse {
  report: { id: string; createDate: string };
  attributes: ReportAttribute[];
  figures: ReportFigure[];
  selectedAttributes?: string[]; // absent from the spec's /info example, so not guaranteed
}

export type ReportRow = Record<string, string | number | null>;

/**
 * etracker prepends a totals row (tree_status "=S"; id "-" per attribute, e.g. "-,-") to every data response,
 * outside of limit/offset. Its figures are deduplicated across rows (unique_visits)
 * or recomputed (rates), so they must never be derived by summing `rows`.
 */
export interface ReportData {
  total?: ReportRow;
  rows: ReportRow[];
}

const TOTAL_ROW_STATUS = "=S";
// One "-" per requested attribute: "-" for one attribute, "-,-" for two, …
const TOTAL_ROW_ID = /^-(,-)*$/;

function isTotalRow(row: ReportRow | undefined): row is ReportRow {
  if (!row) return false;
  return row.tree_status === TOTAL_ROW_STATUS || TOTAL_ROW_ID.test(String(row.id));
}

function splitTotalRow(response: unknown): ReportData {
  if (!Array.isArray(response)) {
    throw new Error(`etracker returned unexpected report data (expected an array, got ${typeof response}).`);
  }
  const [first, ...rest] = response as ReportRow[];
  if (isTotalRow(first)) return { total: first, rows: rest };
  return { rows: response };
}

export interface ReportDataParams {
  reportId: string;
  startDate?: string;
  endDate?: string;
  attributes?: string;   // comma-separated attribute IDs (max 20)
  figures?: string;      // comma-separated key figure IDs
  limit: number;         // required so no query can ever fetch an unbounded result set
  offset?: number;
  sortColumn?: string;
  sortOrder?: "1" | "2"; // 1 = descending, 2 = ascending
  attributeFilter?: AttributeFilter[];
  keyfigureFilter?: KeyfigureFilter[];
}

export interface AttributeFilter {
  filterType: "extended";
  attributeId: string;
  input: string | string[];
  filter: "include" | "exclude";
  type: "contains" | "exact" | "regex";
}

export interface KeyfigureFilter {
  keyfigure: string;
  input: number;
  type: "lt" | "gt" | "eq";
  filter: "include" | "exclude";
}

// ── API methods ──────────────────────────────────────────────────────────────

/** Lists all available reports for this account. */
export async function listReports(token: string): Promise<ReportList> {
  return etrackerFetch<ReportList>(token, "/report");
}

/** Returns attributes and figures available for a report. */
export async function getReportInfo(token: string, reportId: string): Promise<ReportInfoResponse> {
  const result = await etrackerFetch<ReportInfoResponse[]>(token, `/report/${encodeURIComponent(reportId)}/info`);
  if (!result[0]) throw new Error(`No info returned for report "${reportId}". Use list_reports to verify it exists.`);
  return result[0];
}

/** Returns column/metric definitions for a report. */
export async function getReportMetadata(token: string, reportId: string): Promise<ReportColumn[]> {
  return etrackerFetch<ReportColumn[]>(token, `/report/${encodeURIComponent(reportId)}/metaData`);
}

/** Fetches actual report data with optional filtering/sorting/pagination. */
export async function getReportData(token: string, params: ReportDataParams): Promise<ReportData> {
  const { reportId, attributeFilter, keyfigureFilter, limit, offset, ...rest } = params;

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) query[k] = String(v);
  }
  query["limit"] = String(limit);
  if (offset !== undefined) query["offset"] = String(offset);
  if (attributeFilter?.length) query["attributeFilter"] = JSON.stringify(attributeFilter);
  if (keyfigureFilter?.length) query["keyfigureFilter"] = JSON.stringify(keyfigureFilter);

  const response = await etrackerFetch<unknown>(token, `/report/${encodeURIComponent(reportId)}/data`, query);
  return splitTotalRow(response);
}

// ── Semantic helpers (map tool concepts → etracker report IDs) ───────────────

function reportId(envVar: string, fallback: string): string {
  return process.env[envVar] ?? fallback;
}

export function pageviewsReportId(): string {
  return reportId("ETRACKER_REPORT_PAGEVIEWS", "EATime");
}

export function conversionsReportId(): string {
  return reportId("ETRACKER_REPORT_CONVERSIONS", "EAConversions");
}

export function adReportId(): string {
  return reportId("ETRACKER_REPORT_AD", "EAMedium");
}
