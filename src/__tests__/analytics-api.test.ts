import { afterEach, describe, expect, it, vi } from "vitest";
import { getReportData } from "../analytics-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown = []) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getReportData", () => {
  it("always sends the limit query parameter", async () => {
    const fetchMock = stubFetch();
    await getReportData("token", { reportId: "EATime", attributes: "date", limit: 100 });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("attributes")).toBe("date");
  });

  it("splits etracker's leading totals row from the data rows", async () => {
    // Captured from the live API (EATime, attributes=_(month)_, limit=1)
    const total = { id: "-", tree_status: "=S", "_(month)_": "", unique_visits: 549 };
    const row = { id: "125", tree_status: "=0", "_(month)_": " 8", unique_visits: 167 };
    stubFetch([total, row]);
    const data = await getReportData("token", { reportId: "EATime", limit: 1 });
    expect(data).toEqual({ total, rows: [row] });
  });

  it("leaves rows untouched when no totals row is present", async () => {
    const row = { id: "125", unique_visits: 167 };
    stubFetch([row]);
    const data = await getReportData("token", { reportId: "EATime", limit: 1 });
    expect(data).toEqual({ total: undefined, rows: [row] });
  });
});
