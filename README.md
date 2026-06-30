# 🔓 Osmo & Moden Gateway Proxy

Advanced HTTP multi-tenant local proxy equipped with a real-time HTTP Request/Response Payload Inspector, CORS Bypass Manager, and Anti-WAF spoofing headers. It allows bypass of Outseta client-side auth gates for the **Osmo** (`osmo.supply`) and **Moden** (`moden.club`) resources.

---

## Features

- **Multi-Tenant Site Switcher**: Switch contexts between Osmo and Moden dynamically via the dashboard cookie manager.
- **Outseta Mock Integration**: Client-side auth checks are automatically overridden to simulate an active premium user subscription.
- **HTTP request/Response Inspector**: View headers and payload bodies (formatted HTML/JSON) in real-time.
- **CORS Proxy Manager**: 
  - Dynamic discovery of third-party domains.
  - Interactive whitelist management to proxy new hosts on-the-fly without restarting the server.
- **Anti-WAF Fingerprinting**: Automatic header forwarding and spoofing (`sec-ch-ua`, `accept-language`, etc.) to mimic browser fingerprints and bypass edge firewalls.
- **Smart HTML Cache**: Caches scraped target pages with a customizable Time-to-Live (TTL) to speed up loading and reduce outgoing requests.

---

## Getting Started

### Prerequisites

- **Node.js** (v14.0.0 or higher)
- **npm** (v6.0.0 or higher)

### Installation

1. Clone or copy the repository contents:
   ```bash
   git clone <repository-url>
   cd resource-proxy
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

---

## Usage

### 1. Start the Proxy Server

Run the start script to boot the proxy listener on port **4000**:
```bash
npm start
```

### 2. Access the Dashboard

Open your web browser and navigate to:
```
http://localhost:4000/
```

### 3. Basic Workflow

1. **Select a Target Site**: Choose **Osmo** or **Moden** on the dashboard home screen.
2. **Navigate & Browse**: Use the address bar at the top of the dashboard (e.g. type `vault` or `library`) and click **Browse**. The proxy will load the target site while injecting mock premium attributes.
3. **Inspect Requests**: Head back to the dashboard. Click on any log row in the **Intercepted Traffic Log** panel to load its complete headers and body in the **Request Inspector** pane.
4. **Manage CORS Failures**: If an external API or resource fails due to CORS, check the **CORS Proxy Manager** panel. The domain will show up under *Discovered (CORS Warning)*. Click `＋` to instantly route it through the proxy.
5. **Clear Cache**: If you want to fetch fresh contents, click the **✕** next to cache entries or click **Clear Cache** to wipe all stored files.
