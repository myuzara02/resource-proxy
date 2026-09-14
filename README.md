# Resource Proxy

Local HTTP proxy for **Osmo**, **Moden**, and **Annnimate** — bypasses client-side subscription gates and extracts component source code.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:4000
```

Select a target site from the dashboard.

## Supported Sites

### Osmo (`osmo.supply`)
- Outseta auth gate bypass
- CORS proxy + domain whitelist

### Moden (`moden.club`)
- Outseta auth gate bypass
- CORS proxy + domain whitelist

### Annnimate (`annnimate.com`)
- Full Next.js reverse proxy
- **94 library components** — browse, preview, copy source code
- **Kit Reveal** (13 components) + **Kit Menu** (10 components)
- Source code extraction from sandbox iframes (HTML/CSS/JS)
- Code viewer with tabs: Full (plug-and-play) / HTML / CSS / JS + Copy
- Lock overlay removal + customize slider unlock
- Beautified output via js-beautify

## Annnimate Endpoints

| Endpoint | Description |
|----------|-------------|
| `/__proxy__/annnimate/source?component={slug}` | JSON with HTML, CSS, JS |
| `/__proxy__/annnimate/source?component={slug}&format=raw` | Self-contained HTML |
| `/__proxy__/annnimate/kit?kit=reveal` | List kit components |
| `/__proxy__/annnimate/kit?kit=reveal&component={slug}` | Kit component JSON |
| `/__proxy__/annnimate/kit?kit=reveal&component={slug}&format=raw` | Kit component HTML |

Replace `reveal` with `menu` for Menu Kit.

## Features

- **Dashboard** — site switcher, address bar, cache manager, CORS whitelist, request inspector
- **CORS Proxy** — dynamic domain discovery + interactive whitelist
- **Anti-WAF** — header spoofing (sec-ch-ua, accept-language, etc.)
- **HTML Cache** — 24h TTL, per-site cache directories
- **Code Viewer** — injected on component pages with HTML/CSS/JS tabs and copy button

## Files

```
master-proxy.js          # Main proxy server
package.json             # Dependencies
Dockerfile               # Docker deployment
annnimate-starter-pack.zip  # 11 free components (unbuilt source)
```
