# etracker MCP Server

## Project structure

```
etracker-mcp/          # repo root — Node.js/TypeScript MCP server
  src/
    index.ts           # Express app, session store, /mcp + /health endpoints
    auth.ts            # authMiddleware — X-Api-Key + X-ET-Token headers
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
| `ETRACKER_REPORT_PAGEVIEWS` | no | Override default pageviews report ID (default: `EATime`) |
| `ETRACKER_REPORT_CONVERSIONS` | no | Override default conversions report ID (default: `EAConversions`) |
| `ETRACKER_REPORT_AD` | no | Override default ad report ID (default: `EAMarketing`) |

Copy `.env.example` to `.env` for local development. The etracker token is **not** stored in env — partners pass it per request via `X-ET-Token`.

## Authentication model

Every request to `/mcp` requires two headers:

- `X-Api-Key` — MCP server access key (validated against `PARTNER_API_KEYS`, resolves to a `partnerId` used for rate limiting)
- `X-ET-Token` — etracker account token (forwarded directly to the etracker API; never stored server-side)

## Rate limiting

Three-layer bucket in `ratelimit.ts`, checked per request before MCP handling:

1. Burst guard (global): 8 req / 10 s
2. Global window: 40 req / 5 min (80% of etracker's 50 req / 5 min quota)
3. Per-partner window: 20 req / 5 min

Returns HTTP 429 with `Retry-After` header when exceeded.

## MCP tools

All data tools enforce max 90-day date range and max 5 attributes + 5 figures per query. Missing columns default to the first 5 from `get_report_info`.

| Tool | Description |
|---|---|
| `list_reports` | Lists all available reports for the account |
| `get_report_info` | Attributes and figures for a report (use before querying) |
| `get_report_metadata` | Raw column definitions (types, sortable, filterable flags) |
| `get_pageviews` | Web analytics data (default: `EATime`) |
| `get_conversions` | Conversion / e-commerce data (default: `EAConversions`) |
| `get_ad_performance` | Marketing / ad channel data (default: `EAMarketing`) |
| `get_report_data` | Generic — any report, with attribute/keyfigure filters |
| `compare_periods` | Compares a metric column between two date ranges (delta + %) |

## Sessions

MCP sessions are in-memory (`Map<sessionId, StreamableHTTPServerTransport>`). Each partner gets a fresh `McpServer` instance (with their token bound) per session. When running multiple Kubernetes replicas, session affinity (`ClientIP`) is required — configured in the Helm chart.

## Caching

`cache.ts` provides a simple TTL cache (5 min). Cache keys are scoped per token so partners never see each other's data. Used for `list_reports`, `get_report_info`, `get_report_metadata`, and all `getReportData` calls.

## Helm notes

- Never use `--set` for `partnerApiKeys` — Helm treats `{`, `}`, `,` as special syntax. Always use `-f my-values.yaml`.
- Session affinity (`ClientIP`) is enabled by default; increase `sessionAffinityTimeoutSeconds` for long-running sessions.
