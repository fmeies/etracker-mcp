import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../analytics-api.js";
import { createToolRegistrations } from "../tools.js";

// Mock the etracker API so tests never make real HTTP calls.
vi.mock("../analytics-api.js", () => ({
  listReports: vi.fn(),
  getReportInfo: vi.fn(),
  getReportMetadata: vi.fn(),
  getReportData: vi.fn(),
  pageviewsReportId: () => "EATime",
  conversionsReportId: () => "EAConversions",
  adReportId: () => "EAMarketing",
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

// Use a unique token per test to avoid cross-test cache collisions.
let testCounter = 0;
function freshToken() { return `token-${testCounter++}`; }

const allowedSlot = () => ({ allowed: true, retryAfterMs: 0 });
const blockedSlot = () => ({ allowed: false, retryAfterMs: 30_000 });

function tools(token = freshToken()) {
  return createToolRegistrations(token, allowedSlot);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetReportInfo.mockResolvedValue(MOCK_INFO);
  mockGetReportData.mockResolvedValue(MOCK_ROWS);
  mockListReports.mockResolvedValue([{ reportId: "EATime", label: "Month & Year" }]);
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

  it("accepts a valid date range", async () => {
    const handler = tools().find(t => t.name === "get_pageviews")!.handler;
    await expect(handler({ from: "2025-01-01", to: "2025-01-31" })).resolves.toBeDefined();
  });
});

// ── Tool: list_reports ────────────────────────────────────────────────────────

describe("list_reports", () => {
  it("returns JSON with available reports", async () => {
    const handler = tools().find(t => t.name === "list_reports")!.handler;
    const result = await handler({});
    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([{ reportId: "EATime", label: "Month & Year" }]);
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
    expect(data.figures).toEqual([{ id: "visits", label: "Visits", group: undefined }]);
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
    expect(data).toEqual(MOCK_ROWS);
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

// ── Tool: compare_periods ────────────────────────────────────────────────────

describe("compare_periods", () => {
  it("returns delta, change_pct and trend", async () => {
    // Period A: visits = 100, Period B: visits = 150 → delta = 50, trend = up
    mockGetReportData
      .mockResolvedValueOnce([{ visits: 100 }])
      .mockResolvedValueOnce([{ visits: 150 }]);

    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      period_a_from: "2025-01-01", period_a_to: "2025-01-31",
      period_b_from: "2025-02-01", period_b_to: "2025-02-28",
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.delta).toBe(50);
    expect(data.trend).toBe("up");
    expect(data.change_pct).toBe("50.00%");
  });

  it("reports 'down' when the metric decreases", async () => {
    mockGetReportData
      .mockResolvedValueOnce([{ visits: 200 }])
      .mockResolvedValueOnce([{ visits: 100 }]);

    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    const result = await handler({
      metric_column: "visits",
      period_a_from: "2025-01-01", period_a_to: "2025-01-31",
      period_b_from: "2025-02-01", period_b_to: "2025-02-28",
    });
    expect(JSON.parse(result.content[0].text).trend).toBe("down");
  });

  it("validates both period date ranges", async () => {
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      period_a_from: "2025-01-01", period_a_to: "2025-06-01", // > 90 days
      period_b_from: "2025-02-01", period_b_to: "2025-02-28",
    })).rejects.toThrow("90-day limit");
  });

  it("throws when the extra rate limit slot is exhausted", async () => {
    const handler = createToolRegistrations(freshToken(), blockedSlot)
      .find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "visits",
      period_a_from: "2025-01-01", period_a_to: "2025-01-31",
      period_b_from: "2025-02-01", period_b_to: "2025-02-28",
    })).rejects.toThrow("Rate limit exceeded");
  });

  it("throws when metric_column is not present in the result rows", async () => {
    mockGetReportData.mockResolvedValue([{ date: "2025-01-01", visits: 100 }]);
    const handler = tools().find(t => t.name === "compare_periods")!.handler;
    await expect(handler({
      metric_column: "nonexistent_col",
      period_a_from: "2025-01-01", period_a_to: "2025-01-31",
      period_b_from: "2025-02-01", period_b_to: "2025-02-28",
    })).rejects.toThrow(`Column "nonexistent_col" not found`);
  });
});

// ── Tool: get_report_data (generic) ─────────────────────────────────────────

describe("get_report_data", () => {
  it("accepts attribute and keyfigure filters as JSON strings", async () => {
    const handler = tools().find(t => t.name === "get_report_data")!.handler;
    const attrFilter = JSON.stringify([{
      filterType: "standard", attributeId: "url",
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
