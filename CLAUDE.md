# etracker MCP Server

## Project structure

```
etracker-mcp/          # repo root — Node.js/TypeScript MCP server
  src/
    index.ts           # Startup: validates env (fails fast), listens, graceful SIGTERM shutdown
    app.ts             # createApp(): Express app, CORS, /mcp (stateless) + /health endpoints
    auth.ts            # authMiddleware — Authorization: Bearer <partnerKey>.<etrackerToken>
    ratelimit.ts       # Three-layer bucket rate limiter (burst / global / per-partner)
    cache.ts           # In-memory TTL cache (5 min), cache keys scoped per token
    analytics-api.ts   # etracker Reporting API client (BASE_URL: ws.etracker.com/api/v7)
    tools.ts           # MCP tool registrations, Zod schemas, column resolution
  helm/                # Helm chart for Kubernetes deployment
    values.yaml
  Dockerfile           # Multi-stage build, node:24-alpine
```

## Commands

```bash
# Install
npm install

# Dev (tsx, hot-reload via node --import tsx/esm)
npm run dev

# Build
npm run build        # tsc → dist/

# Production
npm start            # node --env-file=.env dist/index.js

# Docker
docker build -t etracker-mcp .
docker run -p 3000:3000 -e PARTNER_API_KEYS='{"key":"partner-a"}' etracker-mcp

# Helm
helm install etracker-mcp ./helm -f my-values.yaml
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PARTNER_API_KEYS` | yes | JSON object: `{"<key>":"<partner-id>"}` — generate keys with `openssl rand -hex 32` |
| `PORT` | no | HTTP port (default: 3000) |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error` (default: `info`) |

Invalid `PARTNER_API_KEYS` (missing, not a JSON object, empty, key containing `.`), `PORT` or `LOG_LEVEL` stop the server at startup.
| `ETRACKER_REPORT_PAGEVIEWS` | no | Override default pageviews report ID (default: `EATime`) |
| `ETRACKER_REPORT_CONVERSIONS` | no | Override default conversions report ID (default: `EAConversions`) |
| `ETRACKER_REPORT_AD` | no | Override default ad report ID (default: `EAMedium`) |

Copy `.env.example` to `.env` for local development. The etracker token is **not** stored in env — partners pass it per request inside the `Authorization` header.

## Authentication model

Every request to `/mcp` requires one header, carrying both credentials:

```
Authorization: Bearer <partnerKey>.<etrackerToken>
```

- `partnerKey` — MCP server access key (validated against `PARTNER_API_KEYS`, resolves to a `partnerId` used for rate limiting)
- `etrackerToken` — etracker account token (forwarded to the etracker API as `X-ET-Token`; never stored server-side)

Both credentials are packed into `Authorization` rather than sent as separate custom headers: some MCP connector proxies (observed with Claude Desktop) silently drop custom headers like `X-Api-Key` even when the header *name* is on Anthropic's approval allowlist — only `Authorization` is reliably forwarded everywhere, since OAuth flows depend on it.

## Rate limiting

`ratelimit.ts` (`createRateLimiter`). A slot is acquired **per actual etracker API call**, inside the tools (`createUpstream` in `tools.ts`), and released when the call finishes — not per HTTP request. MCP protocol traffic (`initialize`, `tools/list`) and cache hits cost nothing; identical concurrent cache misses share one call. Windows are sliding logs, so no 5-minute span can exceed a limit.

1. Parallel guard (global): max 8 calls in flight (etracker allows 10)
2. Burst guard (global): 8 calls / 10 s
3. Global window: 40 calls / 5 min (80% of etracker's 50 calls / 5 min quota)
4. Per-partner window (keyed by `partnerId`): 20 calls / 5 min

When exceeded, the tool call fails with `Rate limit exceeded. Retry after Ns.`

State is in-memory, so the limits only hold for a single replica. The Helm chart refuses to render with `replicaCount > 1`.

## MCP tools

All data tools enforce max 90-day date range and max 5 attributes + 5 figures per query (more is rejected, not truncated). Query size is kept small on purpose:

- **Row limit is always sent** — `ReportDataParams.limit` is required; default 100, max 1000. One extra probe row is fetched so `truncated` is exact; truncated responses carry a next-`offset` hint.
- **Default attributes** — omitted attributes default to the report's own default breakdown (`selectedAttributes`, e.g. year + month for `EATime`), else its first attribute. Each attribute multiplies rows; the row limit bounds the result either way. Omitted figures default to the first 5 visible ones.
- **Validated input** — dates must be real `YYYY-MM-DD` dates (90 days, counted inclusively); filter JSON is checked against Zod schemas matching `report-api.yaml` (max 10 filters each).
- **Totals row** — etracker prepends a totals row (`id: "-"`, `tree_status: "=S"`) to every `/data` response, outside `limit`/`offset`. Its values are deduplicated (`unique_visits`) or recomputed (rates), so they are **not** the sum of the data rows — never sum rows to get a total. `getReportData` splits it into `{ total, rows }`.
- **`compare_periods`** fetches only `metric_column` with `limit=1` and reads the totals row. Periods are `baseline_*` (earlier) and `current_*` (later); `delta = current − baseline`. Non-numeric totals (null, `""`) are errors, never 0.
- **Errors** — etracker answers client errors as HTTP 400 with an `errorCode` (`1012` unknown report, `9000` invalid token); `analytics-api.ts` maps these to actionable messages. Tool failures are logged (`tool call failed`), since the SDK only returns them as `isError`.
- **Server instructions** (`SERVER_INSTRUCTIONS` in `tools.ts`) tell the model the workflow, common report IDs and the quota.

The API spec is in `report-api.yaml` (50 calls / 5 min, 10 parallel, max 100,000 rows per response, max 20 attributes per query).

| Tool | Description |
|---|---|
| `list_reports` | Lists all available reports for the account |
| `get_report_info` | Attributes and figures for a report (use before querying) |
| `get_report_metadata` | Raw column definitions (types, sortable, filterable flags) |
| `get_pageviews` | Web analytics data (default: `EATime`) |
| `get_conversions` | Conversion / e-commerce data (default: `EAConversions`) |
| `get_ad_performance` | Traffic/conversions per marketing channel (default: `EAMedium`; `EAMarketing` does not exist) |
| `get_report_data` | Generic — any report, with attribute/keyfigure filters |
| `compare_periods` | Compares a metric column between two date ranges (delta + %) |

## Sessions

The `/mcp` endpoint is stateless: every request gets a fresh `StreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) and a fresh `McpServer` instance with the caller's token bound, then both are closed once the response finishes. No session ID, no SSE push, no server-side session store — any replica can handle any request, so no session affinity is needed.

## Caching

`cache.ts` provides a simple TTL cache (5 min). Cache keys are scoped per token so partners never see each other's data. Used for `list_reports`, `get_report_info`, `get_report_metadata`, and all `getReportData` calls.

## Helm notes

- `replicaCount` must be 1 and `partnerApiKeys` is required — the chart fails to render otherwise. Deployment strategy is `Recreate` so two limiters never run at once; a secret checksum annotation restarts the pod when keys change.
- Service defaults to `ClusterIP` (expose via the TLS ingress); `NodePort` is opt-in for local testing.
- `.github/workflows/docker.yml` publishes `ghcr.io/fmeies/etracker-mcp` (linux/amd64) on pushes to `main` (`latest`, `sha-*`) and `v*` tags (semver), only after `test.yml` passes (reused via `workflow_call`). The Helm chart and docker-compose default to this image.
- Docker and CI use `npm install`, not `npm ci`: the macOS-generated lockfile lacks Linux-only optional packages (`@emnapi/*`), which makes `npm ci` fail on Alpine.
- The pod runs as non-root (uid 1000) with a read-only root filesystem and all capabilities dropped.

- Never use `--set` for `partnerApiKeys` — Helm treats `{`, `}`, `,` as special syntax. Always use `-f my-values.yaml`.
