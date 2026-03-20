import { createHash } from "node:crypto";
import { z } from "zod";
import { cacheGet, cacheSet, makeCacheKey } from "./cache.js";
import {
  listReports,
  getReportInfo,
  getReportMetadata,
  getReportData,
  pageviewsReportId,
  conversionsReportId,
  adReportId,
  type ReportDataParams,
} from "./analytics-api.js";

const MAX_DAYS = 90;
const MAX_COLUMNS = 5;

// ── Shared helpers ────────────────────────────────────────────────────────────

function parseDateRange(from: string, to: string): void {
  const f = new Date(from);
  const t = new Date(to);
  if (isNaN(f.getTime()) || isNaN(t.getTime()))
    throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (f > t) throw new Error("`from` must be before `to`.");
  const days = (t.getTime() - f.getTime()) / 86_400_000;
  if (days > MAX_DAYS)
    throw new Error(
      `Date range exceeds ${MAX_DAYS}-day limit (requested ${Math.ceil(days)} days).`
    );
}

// Cache keys must be scoped per token so partners don't see each other's data
async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== undefined) return cached;
  const result = await fn();
  cacheSet(key, result);
  return result;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Resolves which attributes and figures to use for a report.
 * - If provided: validate max 5 each, return as-is.
 * - If omitted: fetch report info and use the first 5 attributes /
 *   first 5 visible non-deprecated figures.
 */
async function resolveColumns(
  token: string,
  reportId: string,
  requestedAttributes?: string,
  requestedFigures?: string
): Promise<{ attributes: string; figures: string }> {
  function splitAndLimit(csv: string): string[] {
    return csv.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_COLUMNS);
  }

  if (requestedAttributes && requestedFigures) {
    const attrs = splitAndLimit(requestedAttributes);
    const figs = splitAndLimit(requestedFigures);
    if (attrs.length > MAX_COLUMNS || figs.length > MAX_COLUMNS) {
      throw new Error(`Maximum ${MAX_COLUMNS} attributes and ${MAX_COLUMNS} figures allowed per query.`);
    }
    return { attributes: attrs.join(","), figures: figs.join(",") };
  }

  // Fetch info to fill in defaults
  const ck = makeCacheKey("report_info", { t: tokenHash(token), reportId });
  const info = await withCache(ck, () => getReportInfo(token, reportId));

  const attrs = requestedAttributes
    ? splitAndLimit(requestedAttributes)
    : info.attributes.slice(0, MAX_COLUMNS).map((a) => a.id);

  const figs = requestedFigures
    ? splitAndLimit(requestedFigures)
    : info.figures
        .filter((f) => f.visible && !f.deprecated)
        .slice(0, MAX_COLUMNS)
        .map((f) => f.id);

  return { attributes: attrs.join(","), figures: figs.join(",") };
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const dateRangeShape = {
  from: z.string().describe("Start date (YYYY-MM-DD)"),
  to: z.string().describe("End date (YYYY-MM-DD)"),
};

const columnsShape = {
  attributes: z.string().optional().describe(
    `Up to ${MAX_COLUMNS} comma-separated attribute IDs. Defaults to the first ${MAX_COLUMNS} attributes of the report. Use get_report_info to discover available IDs.`
  ),
  figures: z.string().optional().describe(
    `Up to ${MAX_COLUMNS} comma-separated key figure IDs. Defaults to the first ${MAX_COLUMNS} visible figures of the report. Use get_report_info to discover available IDs.`
  ),
};

const paginationShape = {
  limit: z.number().int().min(1).max(10000).optional().describe("Max rows to return (default: all, max 100,000)"),
  offset: z.number().int().min(0).optional().describe("Pagination offset"),
};

const sortShape = {
  sort_column: z.string().optional().describe("Column ID to sort by"),
  sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
};

const pageviewsShape    = { ...dateRangeShape, ...columnsShape, ...paginationShape, ...sortShape };
const conversionsShape  = { ...dateRangeShape, ...columnsShape, ...paginationShape, ...sortShape };
const adPerformanceShape = { ...dateRangeShape, ...columnsShape, ...paginationShape, ...sortShape };

const getReportDataShape = {
  report_id: z.string().describe("Report ID (e.g. EAPage, EATime, EAGeo). Use list_reports to discover available IDs."),
  ...dateRangeShape,
  ...columnsShape,
  attribute_filter: z.string().optional().describe(
    'JSON array of attribute filters, e.g. [{"filterType":"standard","attributeId":"url","input":"shop","filter":"include","type":"contains"}]'
  ),
  keyfigure_filter: z.string().optional().describe(
    'JSON array of key figure filters, e.g. [{"keyfigure":"visits","input":100,"type":"gt","filter":"show"}]'
  ),
  ...paginationShape,
  ...sortShape,
};

const comparePeriodsShape = {
  report_id: z.string().optional().describe("Report ID to query. Defaults to the pageviews report (EATime)."),
  metric_column: z.string().describe("Figure ID to compare between the two periods (must be included in figures)."),
  period_a_from: z.string().describe("Period A start (YYYY-MM-DD)"),
  period_a_to: z.string().describe("Period A end (YYYY-MM-DD)"),
  period_b_from: z.string().describe("Period B start (YYYY-MM-DD)"),
  period_b_to: z.string().describe("Period B end (YYYY-MM-DD)"),
  ...columnsShape,
};

const listReportsShape = {};

const getReportInfoShape = {
  report_id: z.string().describe("Report ID to inspect (e.g. EAPage, EATime)."),
};

const getReportMetadataShape = {
  report_id: z.string().describe("Report ID to inspect (e.g. EAPage, EATime)."),
};

// ── Shared fetch helpers ──────────────────────────────────────────────────────

function buildParams(
  reportId: string,
  args: {
    from: string;
    to: string;
    attributes?: string;
    figures?: string;
    limit?: number;
    offset?: number;
    sort_column?: string;
    sort_order?: "asc" | "desc";
    attribute_filter?: string;
    keyfigure_filter?: string;
  }
): ReportDataParams {
  return {
    reportId,
    startDate: args.from,
    endDate: args.to,
    attributes: args.attributes,
    figures: args.figures,
    limit: args.limit,
    offset: args.offset,
    sortColumn: args.sort_column,
    sortOrder: args.sort_order === "asc" ? "2" : args.sort_order === "desc" ? "1" : undefined,
    attributeFilter: args.attribute_filter ? JSON.parse(args.attribute_filter) : undefined,
    keyfigureFilter: args.keyfigure_filter ? JSON.parse(args.keyfigure_filter) : undefined,
  };
}

function fetchWithCache(token: string, params: ReportDataParams) {
  const ck = makeCacheKey("report_data", { t: tokenHash(token), ...params as unknown as Record<string, unknown> });
  return withCache(ck, () => getReportData(token, params));
}

// ── Tool registrations (factory — token bound per session) ────────────────────

type ToolContent = { content: Array<{ type: "text"; text: string }> };

const _tokenHashCache = new Map<string, string>();
function tokenHash(token: string): string {
  let h = _tokenHashCache.get(token);
  if (!h) {
    h = createHash("sha256").update(token).digest("hex").slice(0, 16);
    _tokenHashCache.set(token, h);
  }
  return h;
}

export function createToolRegistrations(etrackerToken: string): Array<{
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (input: Record<string, unknown>) => Promise<ToolContent>;
}> {
  return [
    // ── Discovery tools ────────────────────────────────────────────────────
    {
      name: "list_reports",
      description:
        "Lists all available etracker reports for this account. Use this first to discover which report IDs are available (e.g. EAPage, EATime, EAGeo).",
      schema: listReportsShape,
      handler: async () => {
        const ck = makeCacheKey("list_reports", { t: tokenHash(etrackerToken) });
        const data = await withCache(ck, () => listReports(etrackerToken));
        return json(data);
      },
    },
    {
      name: "get_report_info",
      description:
        `Returns available attributes and key figures for a report. Use this to discover valid IDs before querying data. Max ${MAX_COLUMNS} of each can be used per query.`,
      schema: getReportInfoShape,
      handler: async (input) => {
        const { report_id } = z.object(getReportInfoShape).parse(input);
        const ck = makeCacheKey("report_info", { t: tokenHash(etrackerToken), report_id });
        const data = await withCache(ck, () => getReportInfo(etrackerToken, report_id));
        return json({
          attributes: data.attributes.map((a) => ({ id: a.id, label: a.label })),
          figures: data.figures
            .filter((f) => f.visible && !f.deprecated)
            .map((f) => ({ id: f.id, label: f.label, group: f.groupLabel })),
        });
      },
    },
    {
      name: "get_report_metadata",
      description:
        "Returns raw column definitions for a report (types, sortable, filterable flags).",
      schema: getReportMetadataShape,
      handler: async (input) => {
        const { report_id } = z.object(getReportMetadataShape).parse(input);
        const ck = makeCacheKey("report_metadata", { t: tokenHash(etrackerToken), report_id });
        const data = await withCache(ck, () => getReportMetadata(etrackerToken, report_id));
        return json(data);
      },
    },

    // ── Semantic tools ─────────────────────────────────────────────────────
    {
      name: "get_pageviews",
      description: `Returns web analytics data (default report: ${pageviewsReportId()}). Defaults to the first ${MAX_COLUMNS} attributes and figures of the report. Max 90-day range.`,
      schema: pageviewsShape,
      handler: async (input) => {
        const args = z.object(pageviewsShape).parse(input);
        parseDateRange(args.from, args.to);
        const cols = await resolveColumns(etrackerToken, pageviewsReportId(), args.attributes, args.figures);
        const data = await fetchWithCache(etrackerToken, buildParams(pageviewsReportId(), { ...args, ...cols }));
        return json(data);
      },
    },
    {
      name: "get_conversions",
      description: `Returns conversion and e-commerce data (default report: ${conversionsReportId()}). Defaults to the first ${MAX_COLUMNS} attributes and figures. Max 90-day range.`,
      schema: conversionsShape,
      handler: async (input) => {
        const args = z.object(conversionsShape).parse(input);
        parseDateRange(args.from, args.to);
        const cols = await resolveColumns(etrackerToken, conversionsReportId(), args.attributes, args.figures);
        const data = await fetchWithCache(etrackerToken, buildParams(conversionsReportId(), { ...args, ...cols }));
        return json(data);
      },
    },
    {
      name: "get_ad_performance",
      description: `Returns marketing/ad channel performance data (default report: ${adReportId()}). Defaults to the first ${MAX_COLUMNS} attributes and figures. Max 90-day range.`,
      schema: adPerformanceShape,
      handler: async (input) => {
        const args = z.object(adPerformanceShape).parse(input);
        parseDateRange(args.from, args.to);
        const cols = await resolveColumns(etrackerToken, adReportId(), args.attributes, args.figures);
        const data = await fetchWithCache(etrackerToken, buildParams(adReportId(), { ...args, ...cols }));
        return json(data);
      },
    },

    // ── Power tool ─────────────────────────────────────────────────────────
    {
      name: "get_report_data",
      description: `Generic tool: fetch data from any etracker report. Defaults to the first ${MAX_COLUMNS} attributes and figures. Max 90-day range.`,
      schema: getReportDataShape,
      handler: async (input) => {
        const args = z.object(getReportDataShape).parse(input);
        parseDateRange(args.from, args.to);
        const cols = await resolveColumns(etrackerToken, args.report_id, args.attributes, args.figures);
        const data = await fetchWithCache(etrackerToken, buildParams(args.report_id, { ...args, ...cols }));
        return json(data);
      },
    },

    // ── Compare periods ────────────────────────────────────────────────────
    {
      name: "compare_periods",
      description:
        "Compares a metric between two date ranges by summing the metric_column across all rows in each period. Each period max 90 days.",
      schema: comparePeriodsShape,
      handler: async (input) => {
        const args = z.object(comparePeriodsShape).parse(input);
        parseDateRange(args.period_a_from, args.period_a_to);
        parseDateRange(args.period_b_from, args.period_b_to);

        const reportIdToUse = args.report_id ?? pageviewsReportId();
        const cols = await resolveColumns(etrackerToken, reportIdToUse, args.attributes, args.figures);

        const [dataA, dataB] = await Promise.all([
          fetchWithCache(etrackerToken, buildParams(reportIdToUse, {
            from: args.period_a_from, to: args.period_a_to, ...cols,
          })),
          fetchWithCache(etrackerToken, buildParams(reportIdToUse, {
            from: args.period_b_from, to: args.period_b_to, ...cols,
          })),
        ]);

        function sumColumn(rows: typeof dataA, col: string): number {
          return rows.reduce((acc, row) => {
            const val = row[col];
            return acc + (typeof val === "number" ? val : parseFloat(String(val ?? 0)) || 0);
          }, 0);
        }

        const valueA = sumColumn(dataA, args.metric_column);
        const valueB = sumColumn(dataB, args.metric_column);
        const delta = valueB - valueA;
        const pct = valueA !== 0 ? ((delta / valueA) * 100).toFixed(2) : null;

        return json({
          metric: args.metric_column,
          report_id: reportIdToUse,
          period_a: { from: args.period_a_from, to: args.period_a_to, value: valueA },
          period_b: { from: args.period_b_from, to: args.period_b_to, value: valueB },
          delta,
          change_pct: pct ? `${pct}%` : "n/a",
          trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
        });
      },
    },
  ];
}
