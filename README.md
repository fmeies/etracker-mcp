# etracker MCP Server

An MCP (Model Context Protocol) server that exposes the etracker analytics API to AI assistants. Partners connect via HTTP and authenticate with their own API key plus an etracker account token passed per request.

## Architecture

- **Transport:** Stateless StreamableHTTP (`POST /mcp`; no SSE stream)
- **Auth:** Single `Authorization: Bearer <partnerKey>.<etrackerToken>` header (etracker token forwarded upstream as `X-ET-Token`)
- **Rate limiting:** Three-layer bucket per etracker API call (cache hits and protocol traffic are free) — burst guard (8 calls/10 s), global window (40 calls/5 min), per-partner window (20 calls/5 min). In-memory, so run a single replica.
- **Sessions:** Stateless — every request gets a fresh transport + `McpServer`, no session affinity needed.

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/health` | none |
| `ALL` | `/mcp` | required |

## Tools

| Tool | Description |
|------|-------------|
| `list_reports` | Lists all available etracker reports for the account |
| `get_report_info` | Returns available attributes and key figures for a report |
| `get_report_metadata` | Returns raw column definitions (types, sortable, filterable flags) |
| `get_pageviews` | Web analytics data (default report: EATime) |
| `get_conversions` | Conversion and e-commerce data (default report: EAConversions) |
| `get_ad_performance` | Marketing/ad channel performance (default report: EAMarketing) |
| `get_report_data` | Generic tool — fetch data from any report with filters |
| `compare_periods` | Compare a metric between two date ranges |

All data tools accept `from`/`to` (YYYY-MM-DD, max 90 days), optional `attributes` and `figures` (up to 5 each; attributes default to the report's own default breakdown), `limit`/`offset` (default 100 rows, max 1000), and `sort_column`/`sort_order`. Responses are `{ total, rows, row_count, limit, offset, truncated }`, where `total` is etracker's own totals row (deduplicated, not the sum of `rows`). `compare_periods` compares these totals.

## Authentication

The etracker token is **not** stored in the server — partners pass it per request inside the `Authorization` header (forwarded to etracker as `X-ET-Token`). The server only stores the mapping of partner API keys to partner IDs.

Both credentials travel in one `Authorization: Bearer <partnerKey>.<etrackerToken>` header rather than separate custom headers: some MCP connector proxies (observed with Claude Desktop) silently drop custom headers like `X-Api-Key` even when the header name itself is on Anthropic's approval allowlist — only `Authorization` is reliably forwarded everywhere.

Generate a partner key:
```bash
openssl rand -hex 32
```

`PARTNER_API_KEYS` format (JSON object):
```json
{"<key>": "<partner-id>", "<key2>": "<partner-id2>"}
```

## Local development

```bash
cp .env.example .env
# Edit .env and set PARTNER_API_KEYS
npm install && npm run dev
```

## Docker

```bash
docker build -t etracker-mcp .
docker run -p 3000:3000 \
  -e PARTNER_API_KEYS='{"mykey":"partner-a"}' \
  etracker-mcp
```

## Docker Compose

```bash
cp .env.example .env
# Edit .env: set PARTNER_API_KEYS and IMAGE
docker compose up -d
```

## Kubernetes / Helm

**Do not use `--set` for `partnerApiKeys`** — Helm interprets `{`, `}`, and `,` as special syntax and corrupts the JSON. Use a values file instead:

```yaml
# my-values.yaml
partnerApiKeys: '{"<key>":"<partner-id>"}'
service:
  type: ClusterIP  # or NodePort / LoadBalancer
```

```bash
helm install etracker-mcp ./helm -f my-values.yaml
```

### Ingress

```yaml
# my-values.yaml
partnerApiKeys: '{"<key>":"<partner-id>"}'
ingress:
  enabled: true
  className: nginx
  host: etracker-mcp.example.com
  tls: true
  tlsSecretName: etracker-mcp-tls
```

### All Helm values

| Value | Default | Description |
|-------|---------|-------------|
| `partnerApiKeys` | `""` | JSON object mapping API keys to partner IDs |
| `replicaCount` | `1` | Must be 1 — rate limits are in-memory per pod (the chart fails to render otherwise) |
| `logLevel` | `info` | `debug`, `info`, `warn` or `error` |
| `image.repository` | `etracker-mcp` | Container image |
| `image.tag` | `latest` | Image tag |
| `service.type` | `NodePort` | Service type |
| `service.nodePort` | `30300` | NodePort value (30000–32767) |
| `ingress.enabled` | `false` | Enable ingress |
| `ingress.host` | `etracker-mcp.example.com` | Ingress hostname |
| `ingress.tls` | `false` | Enable TLS |
| `etrackerReports.pageviews` | `EATime` | Override default pageviews report ID |
| `etrackerReports.conversions` | `EAConversions` | Override default conversions report ID |
| `etrackerReports.ad` | `EAMarketing` | Override default ad report ID |
| `resources.requests.cpu` | `100m` | CPU request |
| `resources.requests.memory` | `128Mi` | Memory request |
| `resources.limits.cpu` | `500m` | CPU limit |
| `resources.limits.memory` | `256Mi` | Memory limit |

## MCP client configuration

```json
{
  "mcpServers": {
    "etracker": {
      "url": "https://etracker-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <your-partner-key>.<your-etracker-token>"
      }
    }
  }
}
```
