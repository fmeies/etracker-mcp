# etracker MCP Server

An MCP (Model Context Protocol) server that exposes the etracker analytics API to AI assistants. Partners connect via HTTP/SSE and authenticate with their own API key plus an etracker account token passed per request.

## Architecture

- **Transport:** StreamableHTTP (MCP over HTTP + SSE)
- **Auth:** Two-header scheme — `X-Api-Key` (partner key) + `X-ET-Token` (etracker account token)
- **Rate limiting:** Three-layer bucket — burst guard (8 req/10 s), global window (40 req/5 min), per-partner window (20 req/5 min)
- **Sessions:** In-memory, scoped per MCP session. Session affinity (ClientIP) required when running multiple replicas.

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

All data tools accept `from`/`to` (YYYY-MM-DD, max 90 days), optional `attributes` and `figures` (up to 5 each), `limit`/`offset`, and `sort_column`/`sort_order`.

## Authentication

The etracker token is **not** stored in the server — partners pass it per request via `X-ET-Token`. The server only stores the mapping of partner API keys to partner IDs.

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
cp etracker-mcp/.env.example etracker-mcp/.env
# Edit .env and set PARTNER_API_KEYS
cd etracker-mcp && npm install && npm run dev
```

## Docker

```bash
docker build -t etracker-mcp ./etracker-mcp
docker run -p 3000:3000 \
  -e PARTNER_API_KEYS='{"mykey":"partner-a"}' \
  etracker-mcp
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
helm install etracker-mcp ./etracker-mcp-helm -f my-values.yaml
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
| `replicaCount` | `1` | Number of replicas (session affinity handles routing) |
| `image.repository` | `etracker-mcp` | Container image |
| `image.tag` | `latest` | Image tag |
| `service.type` | `ClusterIP` | Service type |
| `service.nodePort` | `""` | NodePort value (30000–32767) |
| `service.sessionAffinityTimeoutSeconds` | `3600` | Session stickiness timeout |
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
        "X-Api-Key": "<your-partner-key>",
        "X-ET-Token": "<your-etracker-token>"
      }
    }
  }
}
```
