import { afterEach, describe, expect, it, vi } from "vitest";
import { getReportData, listReports } from "../analytics-api.js";

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

  it("recognises the totals row when several attributes are requested", async () => {
    // Captured from the live API (EATime, attributes=_(year)_,_(month)_, limit=1): the id is "-,-"
    const total = { id: "-,-", tree_status: "=S", "_(year)_": "", "_(month)_": "", unique_visits: 345 };
    const row = { id: "2026,125", tree_status: "=0", "_(year)_": "2026", "_(month)_": " 8", unique_visits: 167 };
    stubFetch([total, row]);
    const data = await getReportData("token", { reportId: "EATime", attributes: "_(year)_,_(month)_", limit: 1 });
    expect(data).toEqual({ total, rows: [row] });
  });

  it("recognises a totals row by its id alone when tree_status is absent", async () => {
    const total = { id: "-,-,-", unique_visits: 1 };
    stubFetch([total]);
    const data = await getReportData("token", { reportId: "EATime", limit: 1 });
    expect(data.total).toEqual(total);
  });

  it("does not mistake a data row whose id merely starts with a dash", async () => {
    const row = { id: "-12", tree_status: "=0", unique_visits: 1 };
    stubFetch([row]);
    const data = await getReportData("token", { reportId: "EATime", limit: 1 });
    expect(data).toEqual({ total: undefined, rows: [row] });
  });

  it("leaves rows untouched when no totals row is present", async () => {
    const row = { id: "125", unique_visits: 167 };
    stubFetch([row]);
    const data = await getReportData("token", { reportId: "EATime", limit: 1 });
    expect(data).toEqual({ total: undefined, rows: [row] });
  });

  it("rejects a non-array data response with a clear error", async () => {
    stubFetch({ unexpected: true });
    await expect(getReportData("token", { reportId: "EATime", limit: 1 }))
      .rejects.toThrow("expected an array, got object");
  });
});

describe("etracker error messages", () => {
  function stubError(status: number, body: string) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
  }

  // Bodies captured from the live API
  it("explains an unknown report ID (errorCode 1012)", async () => {
    stubError(400, '{"errorCode":1012,"msg":"reportId or reportName does not exist [code:1012] NoSuchReport"}');
    await expect(listReports("token")).rejects.toThrow("Call list_reports to see valid report IDs");
  });

  it("explains an invalid token (errorCode 9000)", async () => {
    stubError(400, '{"errorCode":9000,"msg":"Access token does not exist [code:9000]"}');
    await expect(listReports("token")).rejects.toThrow("The etracker token is invalid");
  });

  it("explains a 403 without a known errorCode", async () => {
    stubError(403, "Forbidden");
    await expect(listReports("token")).rejects.toThrow('"Reporting API" scope');
  });

  it("truncates long error bodies", async () => {
    stubError(500, "x".repeat(5000));
    const error = await listReports("token").catch((e: Error) => e);
    expect((error as Error).message.length).toBeLessThan(700);
  });
});
