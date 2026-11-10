import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../analytics-api.js";
import type { RateLimitResult } from "../ratelimit.js";
import { createToolRegistrations } from "../tools.js";

// Mock the etracker API so tests never make real HTTP calls.
vi.mock("../analytics-api.js", () => ({
  listReports: vi.fn(),
  getReportInfo: vi.fn(),
  getReportMetadata: vi.fn(),
  getReportData: vi.fn(),
  pageviewsReportId: () => "EATime",
  conversionsReportId: () => "EAConversions",
  adReportId: () => "EAMedium",
}));

const mockGetReportInfo = vi.mocked(api.getReportInfo);
const mockGetReportData = vi.mocked(api.getReportData);
const mockListReports   = vi.mocked(api.listReports);

const MOCK_INFO = {
  report: { id: "EATime", createDate: "2024-01-01" },
  attributes: [
    { id: "date", label: "Date", type: "string", sortable: true, filterable: true },
  ],
  figures: [
    { id: "visits", label: "Visits", type: "number", sortable: true, filterable: true, visible: true, deprecated: false, recommended: true },
  ],
  selectedAttributes: [],
};

const MOCK_ROWS = [{ date: "2025-01-01", visits: 100 }];
const MOCK_DATA = { total: { id: "-", tree_status: "=S", visits: 100 }, rows: MOCK_ROWS };

// Shaped like a real etracker totals row: deduplicated, so NOT the sum of the data rows
function withTotal(total: number, rows: Array<Record<string, number>> = [{ visits: 1 }]) {
  return { total: { id: "-", tree_status: "=S", visits: total }, rows };
}

// Use a unique token per test to avoid cross-test cache collisions.
let testCounter = 0;
function freshToken() { return `token-${testCounter++}`; }

const allowedSlot = (): RateLimitResult => ({ allowed: true, release: () => {} });
const blockedSlot = (): RateLimitResult => ({ allowed: false, retryAfterMs: 30_000 });

function tools(token = freshToken()) {
  return createToolRegistrations(token, allowedSlot);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetReportInfo.mockResolvedValue(MOCK_INFO);
  mockGetReportData.mockResolvedValue(MOCK_DATA);
  mockListReports.mockResolvedValue({ EATime: "Month & Year" });
});

// ── Date range validation ────────────────────────────────────────────────────

describe("date range validation", () => {
  it("rejects an invalid date string", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "not-a-date", to: "2025-01-31" }))
      .rejects.toThrow("Invalid date format");
  });

  it("rejects when from is after to", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-02-01", to: "2025-01-01" }))
      .rejects.toThrow("`from` must be before `to`");
  });

  it("rejects a date range longer than 90 days", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-01-01", to: "2025-06-01" }))
      .rejects.toThrow("90-day limit");
  });

  it.each([
    ["a non-ISO date", "Jan 1 2025"],
    ["a date JS would roll over", "2025-02-30"],
    ["a datetime", "2025-01-01T00:00:00Z"],
  ])("rejects %s", async (_case, from) => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from, to: "2025-03-01" })).rejects.toThrow("Invalid date format");
  });

  it("counts the 90-day limit inclusively", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-01-01", to: "2025-03-31" })).resolves.toBeDefined(); // 90 days
    await expect(handler({ from: "2025-01-01", to: "2025-04-01" })).rejects.toThrow("requested 91 days");
  });

  it("accepts a valid date range", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-01-01", to: "2025-01-31" })).resolves.toBeDefined();
  });
});

// ── Rate limiting per upstream call ─────────────────────────────────────────

describe("rate limit slots", () => {
  it("consumes one slot per etracker call and none for cache hits", async () => {
    const consumeRateSlot = vi.fn(allowedSlot);
    const handler = createToolRegistrations(freshToken(), consumeRateSlot)
      .find(t => t.name === "get_pageviews")!.handler;

    await handler({ from: "2025-01-01", to: "2025-01-31" }); // report info + data
    expect(consumeRateSlot).toHaveBeenCalledTimes(2);

    await handler({ from: "2025-01-01", to: "2025-01-31" }); // both cached
    expect(consumeRateSlot).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when the etracker call finishes, even on failure", async () => {
    const release = vi.fn();
    const handler = createToolRegistrations(freshToken(), () => ({ allowed: true, release }))
      .find(t => t.name === "get_pageviews")!.handler;
    mockGetReportData.mockRejectedValueOnce(new Error("upstream down"));
    await expect(handler({ from: "2025-01-01", to: "2025-01-31", attributes: "date", figures: "visits" }))
      .rejects.toThrow("upstream down");
    expect(release).toHaveBeenCalledOnce();
  });

  it("shares one upstream call between identical concurrent requests", async () => {
    const consumeRateSlot = vi.fn(allowedSlot);
    const handler = createToolRegistrations(freshToken(), consumeRateSlot)
      .find(t => t.name === "get_pageviews")!.handler;
    const args = { from: "2025-01-01", to: "2025-01-31", attributes: "date", figures: "visits" };
    await Promise.all([handler(args), handler(args), handler(args)]);
    expect(mockGetReportData).toHaveBeenCalledOnce();
    expect(consumeRateSlot).toHaveBeenCalledOnce();
  });

  it("does not hand one partner's refusal to another partner sharing the token", async () => {
    const token = freshToken();
    const args = { from: "2025-01-01", to: "2025-01-31", attributes: "date", figures: "visits" };
    const capped = createToolRegistrations(token, blockedSlot).find(t => t.name === "get_pageviews")!.handler;
    const withQuota = createToolRegistrations(token, allowedSlot).find(t => t.name === "get_pageviews")!.handler;
    const [refused, served] = await Promise.allSettled([capped(args), withQuota(args)]);
    expect(refused.status).toBe("rejected");
    expect(served.status).toBe("fulfilled");
  });

  it("does not spend quota on invalid filters", async () => {
    const consumeRateSlot = vi.fn(allowedSlot);
    const handler = createToolRegistrations(freshToken(), consumeRateSlot)
      .find(t => t.name === "get_report_data")!.handler;
    await expect(handler({ report_id: "EAPage", from: "2025-01-01", to: "2025-01-31", keyfigure_filter: "[{" }))
      .rejects.toThrow("Invalid JSON");
    expect(consumeRateSlot).not.toHaveBeenCalled();
  });

  it("does not call etracker when no slot is available", async () => {
    const handler = createToolRegistrations(freshToken(), blockedSlot)
      .find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-01-01", to: "2025-01-31", attributes: "date", figures: "visits" }))
      .rejects.toThrow("Rate limit exceeded. Retry after 30s.");
    expect(mockGetReportData).not.toHaveBeenCalled();
  });
});

// ── Tool: list_reports ────────────────────────────────────────────────────────

describe("list_reports", () => {
  it("returns JSON with available reports", async () => {
    const handler = tools().find(t => t.name === "list_reports")!.handler;
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual({ EATime: "Month & Year" });
  });

  it("uses the cache on repeated calls with the same token", async () => {
    const token = freshToken();
    const handler = createToolRegistrations(token, allowedSlot).find(t => t.name === "list_reports")!.handler;
    await handler({});
    await handler({});
    expect(mockListReports).toHaveBeenCalledTimes(1);
  });
});

// ── Tool: get_report_info ────────────────────────────────────────────────────

describe("get_report_info", () => {
  it("returns filtered attributes and figures", async () => {
    const handler = tools().find(t => t.name === "get_report_info")!.handler;
    const result = await handler({ report_id: "EATime" });
    const data = JSON.parse(result.content[0].text);
    expect(data.attributes).toEqual([{ id: "date", label: "Date" }]);
    expect(data.figures).toEqual([{ id: "visits", label: "Visits", group: undefined, recommended: true }]);
  });

  it("excludes deprecated figures", async () => {
    mockGetReportInfo.mockResolvedValueOnce({
      ...MOCK_INFO,
      figures: [
        { id: "old", label: "Old", type: "number", sortable: true, filterable: true, visible: true, deprecated: true, recommended: false },
        { id: "visits", label: "Visits", type: "number", sortable: true, filterable: true, visible: true, deprecated: false, recommended: true },
      ],
    });
    const handler = tools().find(t => t.name === "get_report_info")!.handler;
    const result = await handler({ report_id: "EATime" });
    const data = JSON.parse(result.content[0].text);
    expect(data.figures.map((f: { id: string }) => f.id)).toEqual(["visits"]);
  });
});

// ── Tool: get_pageviews ──────────────────────────────────────────────────────

describe("get_pageviews", () => {
  it("returns rows from the API", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    const result = await handler({ from: "2025-01-01", to: "2025-01-31" });
    const data = JSON.parse(result.content[0].text);
    expect(data.rows).toEqual(MOCK_ROWS);
    expect(data.total).toEqual({ id: "-", visits: 100 }); // tree_status stripped
    expect(data.truncated).toBe(false);
  });

  it("passes custom attributes and figures to the API", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await handler({ from: "2025-01-01", to: "2025-01-31", attributes: "date", figures: "visits" });
    expect(mockGetReportData).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attributes: "date", figures: "visits" }),
    );
  });
});

// ── Query size guards (row limit + minimal attributes) ──────────────────────

describe("query size guards", () => {
  const RANGE = { from: "2025-01-01", to: "2025-01-31" };
  const pageviews = () => tools().find(t => t.name === "get_pageviews")!.handler;
  const sentParams = () => mockGetReportData.mock.calls[0][1];

  const INFO_WITH_MANY_ATTRIBUTES = {
    ...MOCK_INFO,
    attributes: ["date", "browser", "country"].map(id => (
      { id, label: id, type: "string", sortable: true, filterable: true }
    )),
  };

  it("always sends the default row limit of 100, plus one probe row", async () => {
    await pageviews()(RANGE);
    expect(sentParams().limit).toBe(101);
  });

  it("passes an explicit limit through, plus one probe row", async () => {
    await pageviews()({ ...RANGE, limit: 500 });
    expect(sentParams().limit).toBe(501);
  });

  it("rejects a limit above 1000", async () => {
    await expect(pageviews()({ ...RANGE, limit: 1001 })).rejects.toThrow();
    expect(mockGetReportData).not.toHaveBeenCalled();
  });

  it("defaults to the report's own default breakdown (selectedAttributes)", async () => {
    mockGetReportInfo.mockResolvedValueOnce({ ...INFO_WITH_MANY_ATTRIBUTES, selectedAttributes: ["country", "browser"] });
    await pageviews()(RANGE);
    expect(sentParams().attributes).toBe("country,browser");
  });

  it("falls back to the first attribute when info has no selectedAttributes field", async () => {
    mockGetReportInfo.mockResolvedValueOnce({ ...INFO_WITH_MANY_ATTRIBUTES, selectedAttributes: undefined });
    await pageviews()(RANGE);
    expect(sentParams().attributes).toBe("date");
  });

  it("falls back to the first attribute when the report has no default selection", async () => {
    mockGetReportInfo.mockResolvedValueOnce(INFO_WITH_MANY_ATTRIBUTES);
    await pageviews()(RANGE);
    expect(sentParams().attributes).toBe("date");
  });

  it("rejects more than 5 explicit attributes instead of silently truncating", async () => {
    await expect(pageviews()({ ...RANGE, attributes: "a,b,c,d,e,f" }))
      .rejects.toThrow("Too many attributes: 6 requested, max 5");
    expect(mockGetReportData).not.toHaveBeenCalled();
  });

  it("flags a truncated result, drops the probe row and suggests the next offset", async () => {
    mockGetReportData.mockResolvedValueOnce(withTotal(6, [{ visits: 1 }, { visits: 2 }, { visits: 3 }]));
    const result = await pageviews()({ ...RANGE, limit: 2, offset: 4 });
    const data = JSON.parse(result.content[0].text);
    expect(data.truncated).toBe(true);
    expect(data.rows).toEqual([{ visits: 1 }, { visits: 2 }]);
    expect(data.hint).toContain("offset=6");
  });

  it("does not flag a page that exactly fills the limit", async () => {
    mockGetReportData.mockResolvedValueOnce(withTotal(3, [{ visits: 1 }, { visits: 2 }]));
    const result = await pageviews()({ ...RANGE, limit: 2 });
    const data = JSON.parse(result.content[0].text);
    expect(data.truncated).toBe(false);
    expect(data.hint).toBeUndefined();
  });
});

// ── Tool: compare_periods ────────────────────────────────────────────────────

describe("compare_periods", () => {
  it("returns delta, change_pct and trend", async () => {
    // Period A: visits = 100, Period B: visits = 150 → delta = 50, trend = up
    mockGetReportData
      .mockResolvedValueOnce(withTotal(100))
      .mockResolvedValueOnce(withTotal(150));

    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.delta).toBe(50);
    expect(data.trend).toBe("up");
    expect(data.change_pct).toBe("50.00%");
  });

  it("reports 'down' when the metric decreases", async () => {
    mockGetReportData
      .mockResolvedValueOnce(withTotal(200))
      .mockResolvedValueOnce(withTotal(100));

    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    });
    expect(JSON.parse(result.content[0].text).trend).toBe("down");
  });

  it("fetches only the metric column with the smallest possible page", async () => {
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    });
    expect(mockGetReportData).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ figures: "visits", limit: 1 }),
    );
  });

  it("uses etracker's totals row, not the sum of data rows", async () => {
    // Real API: EAPage unique_visits total 549 while page rows sum to 563
    mockGetReportData
      .mockResolvedValueOnce(withTotal(549, [{ visits: 430 }, { visits: 133 }]))
      .mockResolvedValueOnce(withTotal(600, [{ visits: 500 }, { visits: 150 }]));
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.baseline.value).toBe(549);
    expect(data.current.value).toBe(600);
  });

  it("fails the comparison when only the current period gets a slot refused", async () => {
    let calls = 0;
    // 1st slot: report info, 2nd: baseline, 3rd: current → refused
    const slot = (): RateLimitResult => (++calls < 3 ? allowedSlot() : blockedSlot());
    const handler = createToolRegistrations(freshToken(), slot).find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow("Rate limit exceeded");
  });

  it.each([
    ["null", null],
    ["an empty string (an attribute column)", ""],
    ["a non-numeric string", "n/a"],
  ])("rejects a totals value of %s instead of treating it as 0", async (_case, value) => {
    mockGetReportData.mockResolvedValue({ total: { id: "-", visits: value }, rows: [] });
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow("is not numeric");
  });

  it("accepts a numeric string total", async () => {
    mockGetReportData
      .mockResolvedValueOnce({ total: { id: "-", visits: "100" }, rows: [] })
      .mockResolvedValueOnce({ total: { id: "-", visits: "150.5" }, rows: [] });
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    });
    expect(JSON.parse(result.content[0].text).delta).toBe(50.5);
  });

  it.each(["a,b", "", "two words"])("rejects metric_column %j before calling etracker", async (metric) => {
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: metric,
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow();
    expect(mockGetReportData).not.toHaveBeenCalled();
    expect(mockGetReportInfo).not.toHaveBeenCalled();
  });

  it("throws when etracker returns no totals row", async () => {
    mockGetReportData.mockResolvedValue({ rows: [{ visits: 1 }] });
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow("no totals row");
  });

  it("validates both period date ranges", async () => {
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-06-01", // > 90 days
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow("90-day limit");
  });

  it("throws when the extra rate limit slot is exhausted", async () => {
    const handler = createToolRegistrations(freshToken(), blockedSlot)
      .find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow("Rate limit exceeded");
  });

  it("throws when metric_column is not present in the totals row", async () => {
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "nonexistent_col",
      baseline_from: "2025-01-01", baseline_to: "2025-01-31",
      current_from: "2025-02-01", current_to: "2025-02-28",
    })).rejects.toThrow(`Column "nonexistent_col" not found`);
  });
});

// ── Tool: get_report_data (generic) ─────────────────────────────────────────

describe("get_report_data", () => {
  it("accepts attribute and keyfigure filters as JSON strings", async () => {
    const handler = tools().find(t => t.name === "get_report_data")!.handler;
    const attrFilter = JSON.stringify([{
      filterType: "extended", attributeId: "url",
      input: "shop", filter: "include", type: "contains",
    }]);
    await expect(handler({
      report_id: "EAPage",
      from: "2025-01-01", to: "2025-01-31",
      attribute_filter: attrFilter,
    })).resolves.toBeDefined();
    expect(mockGetReportData).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ attributeFilter: expect.any(Array) }),
    );
  });
});

describe("filter validation", () => {
  const reportData = () => tools().find(t => t.name === "get_report_data")!.handler;
  const BASE = { report_id: "EAPage", from: "2025-01-01", to: "2025-01-31" };

  it.each([
    ["the wrong filterType", { attribute_filter: '[{"filterType":"standard","attributeId":"url","input":"x","filter":"include","type":"contains"}]' }, "attribute_filter"],
    ["an unknown attribute filter field", { attribute_filter: '[{"filterType":"extended","attributeId":"url","input":"x","filter":"include","type":"contains","extra":1}]' }, "attribute_filter"],
    ["a non-array attribute filter", { attribute_filter: '{"attributeId":"url"}' }, "attribute_filter"],
    ["a keyfigure filter with filter \"show\"", { keyfigure_filter: '[{"keyfigure":"visits","input":10,"type":"gt","filter":"show"}]' }, "keyfigure_filter"],
    ["a fractional keyfigure input", { keyfigure_filter: '[{"keyfigure":"visits","input":1.5,"type":"gt","filter":"include"}]' }, "keyfigure_filter"],
    ["a non-numeric keyfigure input", { keyfigure_filter: '[{"keyfigure":"visits","input":"10","type":"gt","filter":"include"}]' }, "keyfigure_filter"],
    ["malformed JSON", { keyfigure_filter: "[{" }, "Invalid JSON in keyfigure_filter"],
  ])("rejects %s before calling etracker", async (_case, filter, message) => {
    await expect(reportData()({ ...BASE, ...filter })).rejects.toThrow(message);
    expect(mockGetReportData).not.toHaveBeenCalled();
  });

  it("rejects more than 10 filters", async () => {
    const filter = { keyfigure: "visits", input: 1, type: "gt", filter: "include" };
    await expect(reportData()({ ...BASE, keyfigure_filter: JSON.stringify(Array(11).fill(filter)) }))
      .rejects.toThrow("keyfigure_filter");
  });

  it("passes a valid keyfigure filter through", async () => {
    const filter = [{ keyfigure: "visits", input: 10, type: "gt", filter: "include" }];
    await reportData()({ ...BASE, keyfigure_filter: JSON.stringify(filter) });
    expect(mockGetReportData).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ keyfigureFilter: filter }));
  });
});
