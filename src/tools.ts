import { createHash } from "node:crypto";
import { z } from "zod";
import { cacheGet, cacheSet, makeCacheKey } from "./cache.js";
import type { RateLimitResult } from "./ratelimit.js";
import {
  listReports,
  getReportInfo,
  getReportMetadata,
  getReportData,
  pageviewsReportId,
  conversionsReportId,
  adReportId,
  type ReportDataParams,
  type ReportInfoResponse,
  type ReportData,
  type ReportRow,
  type AttributeFilter,
  type KeyfigureFilter,
} from "./analytics-api.js";

const MAX_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const MAX_COLUMNS = 5;
// Used only when a report has no default selection; each attribute multiplies the row count
const FALLBACK_ATTRIBUTE_COUNT = 1;
const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;
const MAX_FILTERS = 10;
// One row beyond the requested limit tells us exactly whether more rows exist
const TRUNCATION_PROBE_ROWS = 1;
// etracker requires at least one data row per request; the totals row comes on top
const TOTALS_ONLY_LIMIT = 1;
const TOKEN_HASH_LENGTH = 16;
const MS_PER_SECOND = 1000;

export const SERVER_INSTRUCTIONS = `Query etracker web analytics for the connected account.

Workflow: list_reports (report IDs) → get_report_info (attribute and figure IDs for one report) → query.
Common reports: EATime (traffic per year/month; EATimeWeek / EATimeDay for finer grain), EAPage (pages), EAMedium (marketing channels), EACampaign (campaigns), EAReferrer (organic referrers), EAConversions (conversions), EAGeo, EADeviceType.
- For rankings like "top pages", use get_report_data with report_id EAPage, sort_column set to a figure and sort_order "desc".
- For "this period vs. last period", use compare_periods: it compares etracker's own totals, which are correct for unique counts and rates. Never add up rows to get a total — use the "total" field.
- Quota: each partner has about 20 etracker calls per 5 minutes; repeated identical queries within 5 minutes are cached and free. Prefer one well-chosen query over many exploratory ones.
- Date ranges are YYYY-MM-DD, max ${MAX_DAYS} days.`;

const QUERY_DEFAULTS_DESCRIPTION =
  `Request only the attributes you need (max ${MAX_COLUMNS}; default: the report's own default breakdown). Returns at most ${DEFAULT_ROW_LIMIT} rows unless limit is set (max ${MAX_ROW_LIMIT}); "total" holds etracker's period totals. Max ${MAX_DAYS}-day range.`;

// ── Upstream access: cache first, rate-limit slot only on a real API call ─────

type RateSlot = () => RateLimitResult;

interface Upstream {
  token: string;
  cached<T>(name: string, params: Record<string, unknown>, fetch: () => Promise<T>): Promise<T>;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, TOKEN_HASH_LENGTH);
}

// Identical concurrent cache misses share one upstream call (and one rate-limit slot).
// Only calls that already hold a slot are registered, so one partner's refusal is never shared.
// A shared call is charged to the partner that started it; the others ride along for free.
const pendingFetches = new Map<string, Promise<unknown>>();

function createUpstream(token: string, consumeRateSlot: RateSlot): Upstream {
  // Cache keys are scoped per token so partners never see each other's data
  const scope = tokenHash(token);
  return {
    token,
    async cached<T>(name: string, params: Record<string, unknown>, fetch: () => Promise<T>): Promise<T> {
      const key = makeCacheKey(name, { t: scope, ...params });
      const hit = cacheGet<T>(key);
      if (hit !== undefined) return hit;

      const pending = pendingFetches.get(key);
      if (pending) return pending as Promise<T>;

      const slot = consumeRateSlot();
      if (!slot.allowed) {
        throw new Error(`Rate limit exceeded. Retry after ${Math.ceil(slot.retryAfterMs / MS_PER_SECOND)}s.`);
      }
      // Starting from a resolved promise means even a synchronous throw reaches .finally and releases the slot
      const request = Promise.resolve()
        .then(fetch)
        .then((result) => {
          cacheSet(key, result);
          return result;
        })
        .finally(() => {
          slot.release();
          pendingFetches.delete(key);
        });
      pendingFetches.set(key, request);
      return request;
    },
  };
}

function fetchReportInfo(upstream: Upstream, reportId: string): Promise<ReportInfoResponse> {
  return upstream.cached("report_info", { report_id: reportId }, () => getReportInfo(upstream.token, reportId));
}

function fetchReportData(upstream: Upstream, params: ReportDataParams): Promise<ReportData> {
  return upstream.cached("report_data", { ...params }, () => getReportData(upstream.token, params));
}

// ── Input validation ──────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date {
  const date = new Date(`${value}T00:00:00Z`);
  // The round-trip rejects dates JS would silently roll over, like 2025-02-30
  if (!ISO_DATE.test(value) || isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid date format "${value}". Use YYYY-MM-DD.`);
  }
  return date;
}

function validateDateRange(from: string, to: string): void {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (start > end) throw new Error("`from` must be before `to`.");
  const inclusiveDays = (end.getTime() - start.getTime()) / MS_PER_DAY + 1;
  if (inclusiveDays > MAX_DAYS) {
    throw new Error(`Date range exceeds ${MAX_DAYS}-day limit (requested ${inclusiveDays} days).`);
  }
}

const attributeFilterSchema = z.array(z.object({
  filterType: z.literal("extended"),
  attributeId: z.string().min(1),
  input: z.union([z.string(), z.array(z.string()).min(1)]),
  filter: z.enum(["include", "exclude"]),
  type: z.enum(["contains", "exact", "regex"]),
}).strict()).max(MAX_FILTERS);

const keyfigureFilterSchema = z.array(z.object({
  keyfigure: z.string().min(1),
  input: z.number().int(),
  type: z.enum(["lt", "gt", "eq"]),
  filter: z.enum(["include", "exclude"]),
}).strict()).max(MAX_FILTERS);

function parseFilter<T>(value: string, schema: z.ZodType<T>, field: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in ${field}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid ${field}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function parseColumnList(csv: string, field: string): string[] {
  const ids = csv.split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length > MAX_COLUMNS) {
    throw new Error(`Too many ${field}: ${ids.length} requested, max ${MAX_COLUMNS}. Request only the columns you need.`);
  }
  return ids;
}

// ── Column resolution ─────────────────────────────────────────────────────────

function defaultAttributes(info: ReportInfoResponse): string[] {
  // The report's own default breakdown (e.g. year + month for EATime) is its natural grain
  if (info.selectedAttributes?.length) return info.selectedAttributes.slice(0, MAX_COLUMNS);
  return info.attributes.slice(0, FALLBACK_ATTRIBUTE_COUNT).map((a) => a.id);
}

function defaultFigures(info: ReportInfoResponse): string[] {
  return info.figures
    .filter((f) => f.visible && !f.deprecated)
    .slice(0, MAX_COLUMNS)
    .map((f) => f.id);
}

/**
 * Explicit column lists are validated (max 5 each); omitted lists fall back
 * to the report's defaults, which costs one (cached) report-info call.
 */
async function resolveColumns(
  upstream: Upstream,
  reportId: string,
  requestedAttributes?: string,
  requestedFigures?: string
): Promise<{ attributes: string; figures: string }> {
  const attrs = requestedAttributes ? parseColumnList(requestedAttributes, "attributes") : [];
  const figs = requestedFigures ? parseColumnList(requestedFigures, "figures") : [];

  if (attrs.length === 0 || figs.length === 0) {
    const info = await fetchReportInfo(upstream, reportId);
    if (attrs.length === 0) attrs.push(...defaultAttributes(info));
    if (figs.length === 0) figs.push(...defaultFigures(info));
  }

  return { attributes: attrs.join(","), figures: figs.join(",") };
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const dateRangeShape = {
  from: z.string().describe("Start date (YYYY-MM-DD)"),
  to: z.string().describe("End date (YYYY-MM-DD)"),
};

const columnsShape = {
  attributes: z.string().optional().describe(
    `Up to ${MAX_COLUMNS} comma-separated attribute IDs. Each attribute multiplies the number of rows, so request only the breakdowns you need. Defaults to the report's own default breakdown. Use get_report_info to discover available IDs.`
  ),
  figures: z.string().optional().describe(
    `Up to ${MAX_COLUMNS} comma-separated key figure IDs. Defaults to the first ${MAX_COLUMNS} visible figures of the report. Use get_report_info to discover available IDs.`
  ),
};

const paginationShape = {
  limit: z.number().int().min(1).max(MAX_ROW_LIMIT).optional().describe(
    `Max rows to return (default: ${DEFAULT_ROW_LIMIT}, max ${MAX_ROW_LIMIT}). Check "truncated" in the response and page with offset if needed.`
  ),
  offset: z.number().int().min(0).optional().describe("Pagination offset"),
};

const sortShape = {
  sort_column: z.string().optional().describe("Column ID to sort by"),
  sort_order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default: desc)"),
};

const reportQueryShape = { ...dateRangeShape, ...columnsShape, ...paginationShape, ...sortShape };

const getReportDataShape = {
  report_id: z.string().describe("Report ID (e.g. EAPage, EATime, EAGeo). Use list_reports to discover available IDs."),
  ...reportQueryShape,
  attribute_filter: z.string().optional().describe(
    `JSON array (max ${MAX_FILTERS}) of attribute filters. filterType must be "extended"; input may be a string or an array of strings (OR-matched); filter is "include" or "exclude"; type is "contains", "exact" or "regex". E.g. [{"filterType":"extended","attributeId":"url","input":["/en/","/fr/"],"filter":"include","type":"contains"}]`
  ),
  keyfigure_filter: z.string().optional().describe(
    `JSON array (max ${MAX_FILTERS}) of key figure filters. type is "lt", "gt" or "eq"; filter is "include" or "exclude". E.g. [{"keyfigure":"unique_visits","input":10,"type":"gt","filter":"include"}]`
  ),
};

const SINGLE_ID = /^[^,\s]+$/;

const comparePeriodsShape = {
  report_id: z.string().optional().describe("Report ID to query. Defaults to the pageviews report (EATime)."),
  metric_column: z.string().regex(SINGLE_ID, "metric_column must be a single key figure ID").describe(
    "One key figure ID to compare, e.g. unique_visits. Use get_report_info to discover IDs."
  ),
  baseline_from: z.string().describe("Baseline (earlier) period start, YYYY-MM-DD — e.g. the month before"),
  baseline_to: z.string().describe("Baseline (earlier) period end, YYYY-MM-DD"),
  current_from: z.string().describe("Current (later) period start, YYYY-MM-DD — e.g. last month"),
  current_to: z.string().describe("Current (later) period end, YYYY-MM-DD"),
};

const reportIdShape = {
  report_id: z.string().describe("Report ID to inspect (e.g. EAPage, EATime)."),
};

// ── Report queries ────────────────────────────────────────────────────────────

interface QueryArgs {
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

const SORT_ORDER = { desc: "1", asc: "2" } as const;

interface ParsedFilters {
  attributeFilter?: AttributeFilter[];
  keyfigureFilter?: KeyfigureFilter[];
}

function parseFilters(args: QueryArgs): ParsedFilters {
  return {
    attributeFilter: args.attribute_filter
      ? parseFilter(args.attribute_filter, attributeFilterSchema, "attribute_filter")
      : undefined,
    keyfigureFilter: args.keyfigure_filter
      ? parseFilter(args.keyfigure_filter, keyfigureFilterSchema, "keyfigure_filter")
      : undefined,
  };
}

function buildParams(reportId: string, args: QueryArgs, filters: ParsedFilters = {}): ReportDataParams {
  return {
    reportId,
    startDate: args.from,
    endDate: args.to,
    attributes: args.attributes,
    figures: args.figures,
    limit: args.limit ?? DEFAULT_ROW_LIMIT,
    offset: args.offset,
    sortColumn: args.sort_column,
    sortOrder: args.sort_order && SORT_ORDER[args.sort_order],
    ...filters,
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// etracker's internal row-type marker ("=S" totals, "=0" data) is noise for the model
const TREE_STATUS_FIELD = "tree_status";

function withoutTreeStatus(row: ReportRow): ReportRow {
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== TREE_STATUS_FIELD));
}

function rowsResult(data: ReportData, limit: number, offset = 0) {
  const truncated = data.rows.length > limit;
  const rows = data.rows.slice(0, limit).map(withoutTreeStatus);
  return json({
    total: data.total && withoutTreeStatus(data.total),
    rows,
    row_count: rows.length,
    limit,
    offset,
    truncated,
    ...(truncated && {
      hint: `Result capped at ${limit} rows. Narrow the query (fewer attributes, filters, shorter range) or fetch the next page with offset=${offset + limit}.`,
    }),
  });
}

async function queryReport(upstream: Upstream, reportId: string, args: QueryArgs) {
  // Validate everything before any upstream call, so bad input never costs quota
  validateDateRange(args.from, args.to);
  const filters = parseFilters(args);
  const cols = await resolveColumns(upstream, reportId, args.attributes, args.figures);
  const params = buildParams(reportId, { ...args, ...cols }, filters);
  const data = await fetchReportData(upstream, { ...params, limit: params.limit + TRUNCATION_PROBE_ROWS });
  return rowsResult(data, params.limit, params.offset);
}

function toNumber(value: string | number | null): number | undefined {
  // Number(null) and Number("") are 0, which would silently report an empty total as zero
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function totalValue(data: ReportData, metric: string): number {
  if (!data.total) {
    throw new Error("etracker returned no totals row, so the period total is unknown.");
  }
  const value = data.total[metric];
  if (value === undefined) {
    throw new Error(`Column "${metric}" not found in report results. Use get_report_info to discover available figure IDs.`);
  }
  const numeric = toNumber(value);
  if (numeric === undefined) {
    throw new Error(`Total for "${metric}" is not numeric (${JSON.stringify(value)}). metric_column must be a key figure, not an attribute.`);
  }
  return numeric;
}

function trendOf(delta: number): "up" | "down" | "flat" {
  if (delta > 0) return "up";
  if (delta < 0) return "down";
  return "flat";
}

async function comparePeriods(upstream: Upstream, args: z.infer<z.ZodObject<typeof comparePeriodsShape>>) {
  validateDateRange(args.baseline_from, args.baseline_to);
  validateDateRange(args.current_from, args.current_to);

  const reportId = args.report_id ?? pageviewsReportId();
  // Only the totals row is used, so fetch the metric alone with the smallest page
  const cols = await resolveColumns(upstream, reportId, undefined, args.metric_column);
  const periodTotal = async (from: string, to: string) => {
    const data = await fetchReportData(upstream, buildParams(reportId, { from, to, ...cols, limit: TOTALS_ONLY_LIMIT }));
    return totalValue(data, args.metric_column);
  };

  const [baseline, current] = await Promise.all([
    periodTotal(args.baseline_from, args.baseline_to),
    periodTotal(args.current_from, args.current_to),
  ]);
  const delta = current - baseline;
  const pct = baseline !== 0 ? ((delta / baseline) * 100).toFixed(2) : null;

  return json({
    metric: args.metric_column,
    report_id: reportId,
    baseline: { from: args.baseline_from, to: args.baseline_to, value: baseline },
    current: { from: args.current_from, to: args.current_to, value: current },
    delta,
    change_pct: pct ? `${pct}%` : "n/a",
    trend: trendOf(delta),
  });
}

// ── Tool registrations (factory — token bound per request) ────────────────────

type ToolContent = { content: Array<{ type: "text"; text: string }> };

export interface ToolRegistration {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (input: Record<string, unknown>) => Promise<ToolContent>;
}

function reportQueryTool(name: string, purpose: string, reportId: () => string, upstream: Upstream): ToolRegistration {
  return {
    name,
    description: `Returns ${purpose} (default report: ${reportId()}). ${QUERY_DEFAULTS_DESCRIPTION}`,
    schema: reportQueryShape,
    handler: async (input) => queryReport(upstream, reportId(), z.object(reportQueryShape).parse(input)),
  };
}

/** Every etracker call made by these tools consumes a rate-limit slot via consumeRateSlot; cache hits do not. */
export function createToolRegistrations(etrackerToken: string, consumeRateSlot: RateSlot): ToolRegistration[] {
  const upstream = createUpstream(etrackerToken, consumeRateSlot);

  return [
    {
      name: "list_reports",
      description:
        "Lists all available etracker reports for this account as { reportId: label }. Use this first to discover which report IDs are available (e.g. EAPage, EATime, EAGeo).",
      schema: {},
      handler: async () => json(await upstream.cached("list_reports", {}, () => listReports(etrackerToken))),
    },
    {
      name: "get_report_info",
      description:
        `Returns available attributes and key figures for a report. Use this to discover valid IDs before querying data. Max ${MAX_COLUMNS} of each can be used per query.`,
      schema: reportIdShape,
      handler: async (input) => {
        const { report_id } = z.object(reportIdShape).parse(input);
        const info = await fetchReportInfo(upstream, report_id);
        return json({
          default_attributes: info.selectedAttributes ?? [],
          attributes: info.attributes.map((a) => ({ id: a.id, label: a.label })),
          figures: info.figures
            .filter((f) => f.visible && !f.deprecated)
            .map((f) => ({ id: f.id, label: f.label, group: f.groupLabel, recommended: f.recommended })),
        });
      },
    },
    {
      name: "get_report_metadata",
      description: "Returns raw column definitions for a report (types, sortable, filterable flags).",
      schema: reportIdShape,
      handler: async (input) => {
        const { report_id } = z.object(reportIdShape).parse(input);
        return json(await upstream.cached("report_metadata", { report_id }, () => getReportMetadata(etrackerToken, report_id)));
      },
    },

    reportQueryTool("get_pageviews", "traffic over time — visits, visitors and page impressions per year/month, not per page (for top pages use get_report_data with EAPage)", pageviewsReportId, upstream),
    reportQueryTool("get_conversions", "conversion and e-commerce data", conversionsReportId, upstream),
    reportQueryTool("get_ad_performance", "traffic and conversions per marketing channel (medium)", adReportId, upstream),

    {
      name: "get_report_data",
      description: `Generic tool: fetch data from any etracker report, with optional attribute/key figure filters. ${QUERY_DEFAULTS_DESCRIPTION}`,
      schema: getReportDataShape,
      handler: async (input) => {
        const args = z.object(getReportDataShape).parse(input);
        return queryReport(upstream, args.report_id, args);
      },
    },
    {
      name: "compare_periods",
      description:
        `Compares one key figure between a baseline (earlier) and a current (later) period using etracker's own period totals (correct for unique counts and rates alike). delta = current − baseline; change_pct is relative to the baseline. Each period max ${MAX_DAYS} days.`,
      schema: comparePeriodsShape,
      handler: async (input) => comparePeriods(upstream, z.object(comparePeriodsShape).parse(input)),
    },
  ];
}
