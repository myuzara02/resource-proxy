# Resource Proxy

Local HTTP proxy for **Osmo**, **Moden**, and **Annnimate** — bypasses client-side subscription gates, extracts original source code, and provides a unified dashboard.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:4000
```

Select a target site from the dashboard.

## Supported Sites

### Osmo (`osmo.supply`)
- Outseta auth gate bypass (mock premium subscription)
- CORS proxy + dynamic domain whitelist
- Anti-WAF header spoofing

### Moden (`moden.club`)
- Outseta auth gate bypass (mock premium subscription)
- CORS proxy + dynamic domain whitelist
- Webflow/Supabase edge router bypass

### Annnimate (`annnimate.com`)
- Full Next.js reverse proxy (SSR + RSC + API + assets)
- **95 library components** — original unbuilt source code (React, Vue, JS, CSS, HTML)
- **Kit Reveal** (13 components) + **Kit Menu** (10 components) — built JS from sandbox
- Source code extracted via Supabase REST API (anon key from public JS bundle)
- Code viewer with syntax highlighting on `data-anm-*` attributes
- Tabs: ⚡ Full | HTML | CSS | JS | ⚛ React | ◆ Vue | 📋 Copy
- Native customize panel unlocked — changes sync live to code viewer
- Changed values highlighted in green, defaults in blue
- Lock overlays, paywall CTAs, and disabled controls removed

## Annnimate Endpoints

### Original Source (via Supabase)

| Endpoint | Description |
|----------|-------------|
| `/__proxy__/annnimate/original` | List all 95 components |
| `/__proxy__/annnimate/original?component={slug}` | Full JSON (all formats + controls + tips + specs) |
| `/__proxy__/annnimate/original?component={slug}&format=react` | Raw `.jsx` file |
| `/__proxy__/annnimate/original?component={slug}&format=vue` | Raw `.vue` SFC |
| `/__proxy__/annnimate/original?component={slug}&format=js` | Raw vanilla `.js` |
| `/__proxy__/annnimate/original?component={slug}&format=css` | Raw `.css` |
| `/__proxy__/annnimate/original?component={slug}&format=html` | Raw `.html` |

### Built Source (via sandbox iframe)

| Endpoint | Description |
|----------|-------------|
| `/__proxy__/annnimate/source?component={slug}` | JSON (beautified HTML/CSS/JS) |
| `/__proxy__/annnimate/source?component={slug}&format=raw` | Self-contained HTML |

### Kits

| Endpoint | Description |
|----------|-------------|
| `/__proxy__/annnimate/kit?kit=reveal` | List kit components |
| `/__proxy__/annnimate/kit?kit=reveal&component={slug}` | Kit component JSON |
| `/__proxy__/annnimate/kit?kit=reveal&component={slug}&format=raw` | Kit component HTML |

Replace `reveal` with `menu` for Menu Kit.

## Features

- **Dashboard** — site switcher, address bar, cache manager, CORS whitelist, request inspector
- **CORS Proxy** — dynamic domain discovery + interactive whitelist management
- **Anti-WAF** — header spoofing with rotating User-Agents (5 UA pool)
- **HTML Cache** — 24h TTL per-site cache directories, persistent across restarts
- **Supabase Cache** — 12h TTL, persisted to disk, survives server restart (51ms vs 2.8s)
- **Rate Limiting** — 2s minimum between Supabase requests to avoid detection
- **Code Viewer** — injected on component pages with Full/HTML/CSS/JS/React/Vue tabs
- **Attribute Highlighting** — `data-anm-*` values highlighted; changed values in green
- **Customize Sync** — native annnimate panel changes auto-update code viewer
- **Beautified Output** — JS/CSS/HTML formatted via js-beautify

## Security

- Rotating User-Agent pool across all outgoing requests
- Rate-limited Supabase queries (2s interval)
- Persistent cache minimizes upstream traffic (zero hits on warm start)
- `headersSent` guards on all error handlers (prevents crashes)
- Graceful shutdown saves cache on SIGINT/SIGTERM
- Connection limits: 50 max, 10s keepalive, 15s headers timeout
- `uncaughtException` / `unhandledRejection` handlers prevent process death

## Files

```
master-proxy.js             # Main proxy server (~2800 lines)
package.json                # Dependencies (node-fetch, cheerio, js-beautify)
Dockerfile                  # Docker deployment (node:22-slim)
annnimate-starter-pack.zip  # 11 free components (original unbuilt source)
.gitignore                  # Cache dirs + node_modules excluded
```

## Cache Structure

```
.cache_osmo/                # Osmo HTML page cache
.cache_moden/               # Moden HTML page cache
.cache_annnimate/           # Annnimate HTML page cache
  _supabase_cache.json      # Persisted Supabase query cache
```
