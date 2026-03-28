/**
 * etracker Reporting API client
 * Docs: https://docs.etracker.com/api/report.html
 *
 * Optional env vars (report IDs — override defaults per account):
 *   ETRACKER_REPORT_PAGEVIEWS    (default: EATime)
 *   ETRACKER_REPORT_CONVERSIONS  (default: EAConversions)
 *   ETRACKER_REPORT_AD           (default: EAMarketing)
 *
 * The etracker account token is not stored here — it is passed per request
 * via the X-ET-Token header and forwarded directly to the API.
 */

const BASE_URL = "https://ws.etracker.com/api/v7";

async function etrackerFetch<T>(token: string, path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      "X-ET-Token": token,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`etracker API error ${res.status} ${res.statusText}: ${body}`);
  }

  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ReportListItem {
  reportId: string;
  label: string;
  description?: string;
}

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
  selectedAttributes: string[];
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportDataParams {
  reportId: string;
  startDate?: string;
  endDate?: string;
  attributes?: string;   // comma-separated attribute IDs (max 20)
  figures?: string;      // comma-separated key figure IDs
  limit?: number;
  offset?: number;
  sortColumn?: string;
  sortOrder?: "1" | "2"; // 1 = descending, 2 = ascending
  attributeFilter?: AttributeFilter[];
  keyfigureFilter?: KeyfigureFilter[];
}

export interface AttributeFilter {
  filterType: string;
  attributeId: string;
  input: string;
  filter: "include" | "exclude";
  type: "contains" | "exact" | "regex";
}

export interface KeyfigureFilter {
  keyfigure: string;
  input: number;
  type: "lt" | "gt" | "eq";
  filter: string;
}

// ── API methods ──────────────────────────────────────────────────────────────

/** Lists all available reports for this account. */
export async function listReports(token: string): Promise<ReportListItem[]> {
  return etrackerFetch<ReportListItem[]>(token, "/report");
}

/** Returns attributes and figures available for a report. */
export async function getReportInfo(token: string, reportId: string): Promise<ReportInfoResponse> {
  const result = await etrackerFetch<ReportInfoResponse[]>(token, `/report/${encodeURIComponent(reportId)}/info`);
  return result[0]!;
}

/** Returns column/metric definitions for a report. */
export async function getReportMetadata(token: string, reportId: string): Promise<ReportColumn[]> {
  return etrackerFetch<ReportColumn[]>(token, `/report/${encodeURIComponent(reportId)}/metaData`);
}

/** Fetches actual report data with optional filtering/sorting/pagination. */
export async function getReportData(token: string, params: ReportDataParams): Promise<ReportRow[]> {
  const { reportId, attributeFilter, keyfigureFilter, limit, offset, ...rest } = params;

  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined) query[k] = String(v);
  }
  if (limit !== undefined) query["limit"] = String(limit);
  if (offset !== undefined) query["offset"] = String(offset);
  if (attributeFilter?.length) query["attributeFilter"] = JSON.stringify(attributeFilter);
  if (keyfigureFilter?.length) query["keyfigureFilter"] = JSON.stringify(keyfigureFilter);

  return etrackerFetch<ReportRow[]>(token, `/report/${encodeURIComponent(reportId)}/data`, query);
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
  return reportId("ETRACKER_REPORT_AD", "EAMarketing");
}
