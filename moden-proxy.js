const http = require('http');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const PORT = process.env.PORT || 3457;
const TARGET_ORIGIN = 'https://moden.club';
const CACHE_DIR = path.join(__dirname, '.cache_moden');
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

const PROXIED_DOMAINS = [
  'cdn.prod.website-files.com',
  'cdn.moden.club',
  'config.outseta.com',
  'cdn.outseta.com',
  'modenclub.outseta.com',
  'code-editor.moden.workers.dev',
  'html-to-webflow.moden.workers.dev',
  'asset-editor.moden.workers.dev',
  'layout-wizard.moden.workers.dev',
  'css-animator.moden.workers.dev',
];

// ─── Cache System ────────────────────────────────────────────────────────
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheKey(urlPath) {
  return encodeURIComponent(urlPath).replace(/%/g, '_');
}

function getCachePath(urlPath) {
  return path.join(CACHE_DIR, getCacheKey(urlPath) + '.html');
}

function getCacheMetaPath(urlPath) {
  return path.join(CACHE_DIR, getCacheKey(urlPath) + '.meta.json');
}

function isCacheValid(urlPath) {
  const metaPath = getCacheMetaPath(urlPath);
  if (!fs.existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return (Date.now() - meta.timestamp) < CACHE_TTL;
  } catch {
    return false;
  }
}

function readCache(urlPath) {
  const cachePath = getCachePath(urlPath);
  const metaPath = getCacheMetaPath(urlPath);
  if (!fs.existsSync(cachePath) || !fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const html = fs.readFileSync(cachePath, 'utf-8');
    return { html, meta };
  } catch {
    return null;
  }
}

function writeCache(urlPath, html) {
  const cachePath = getCachePath(urlPath);
  const metaPath = getCacheMetaPath(urlPath);
  const meta = {
    path: urlPath,
    timestamp: Date.now(),
    cachedAt: new Date().toISOString(),
    size: Buffer.byteLength(html, 'utf-8'),
  };
  fs.writeFileSync(cachePath, html, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

function clearCacheEntry(urlPath) {
  if (urlPath) {
    const cachePath = getCachePath(urlPath);
    const metaPath = getCacheMetaPath(urlPath);
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } else {
    if (!fs.existsSync(CACHE_DIR)) return;
    const files = fs.readdirSync(CACHE_DIR);
    files.forEach(f => fs.unlinkSync(path.join(CACHE_DIR, f)));
  }
}

function listCacheEntries() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.meta.json'));
  return files.map(f => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8'));
      meta.isValid = (Date.now() - meta.timestamp) < CACHE_TTL;
      meta.expiresIn = Math.max(0, CACHE_TTL - (Date.now() - meta.timestamp));
      return meta;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── Outseta mock stub ──────────────────────────────────────────────────────
// This prevents "Outseta not found" errors from dependent scripts
const OUTSETA_MOCK_SCRIPT = `
<script>
// Osmo Proxy: Mock Outseta with premium active subscription
(function() {
  var noopFn = function() { return Promise.resolve(); };
  var noopObj = new Proxy({}, { get: function(t, p) {
    if (p === 'then') return undefined;
    return typeof p === 'string' ? noopFn : undefined;
  }});
  
  var mockUser = {
    Email: 'premium_user@example.com',
    FirstName: 'Premium',
    LastName: 'User',
    FullName: 'Premium User',
    Uid: 'mock_uid_12345',
    Account: {
      Name: 'Premium Account',
      AccountStage: 2, // Active stage
      CurrentSubscription: {
        Plan: {
          Name: 'Premium All-Access',
          Uid: 'mock_plan_premium'
        },
        StartDate: new Date().toISOString(),
        EndDate: new Date(Date.now() + 365*24*60*60*1000).toISOString()
      }
    }
  };
  
  window.Outseta = window.Outseta || {
    on: function(event, callback) {
      if (typeof callback === 'function') {
        if (event === 'subscription.created' || event === 'subscription.updated') {
          // Trigger callbacks if needed
        }
      }
    },
    off: function() {},
    emit: function() {},
    getUser: function() { return Promise.resolve(mockUser); },
    getAccessToken: function() { return Promise.resolve('mock_access_token_jwt_signature'); },
    isReady: function() { return Promise.resolve(true); },
    auth: noopObj,
    profile: noopObj,
    support: noopObj,
    nocode: noopObj,
    chat: noopObj
  };
  
  // Also set o_options so config scripts don't error
  window.o_options = window.o_options || {};
})();
</script>
`;

// ─── Protection patterns to strip ───────────────────────────────────────────
function stripProtection(html, requestPath) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // 1. Remove <noscript> tags containing redirect to /no-access
  $('noscript').each((_, el) => {
    const content = $(el).html();
    if (content && content.includes('no-access')) {
      $(el).remove();
    }
  });

  // 2. Remove <script> tags with protection logic
  $('script').each((_, el) => {
    const text = $(el).html() || '';

    // Outseta gate: (!!window.Outseta) || (window.location.href = ...)
    if (text.includes('window.Outseta') && text.includes('window.location')) {
      $(el).remove();
      return;
    }

    // Redirect to /no-access
    if (text.includes('/no-access') && text.includes('location.replace')) {
      $(el).remove();
      return;
    }

    // Post-logout redirect
    if (text.includes('postLogoutRedirect') && text.includes('location.replace')) {
      $(el).remove();
      return;
    }
  });

  // 3. Remove <meta name="robots" content="noindex">
  $('meta[name="robots"][content="noindex"]').remove();

  // 4. Remove Outseta real script + config (replace with mock)
  $('script[src*="outseta.min.js"]').remove();
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes("var o_options") && text.includes("outseta.com")) {
      $(el).remove();
    }
    // Remove Outseta signup tracking
    if (text.includes('Outseta.on(') && text.includes('signup')) {
      $(el).remove();
    }
  });

  // Force auth state to subscribed
  $('html').attr('data-auth', 'subscribed');

  // 5. Inject Outseta mock as FIRST script in <head> so it's available to all
  $('head').prepend(OUTSETA_MOCK_SCRIPT);

  // 6. Remove any [data-o-*] gating attributes from Outseta
  $('[data-o-anonymous]').removeAttr('data-o-anonymous');
  $('[data-o-auth]').removeAttr('data-o-auth');
  $('[data-o-logout]').removeAttr('data-o-logout');

  // 8. Rewrite internal links to go through proxy
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith(TARGET_ORIGIN)) {
      $(el).attr('href', href.replace(TARGET_ORIGIN, ''));
    }
  });

  // 9. Rewrite fetch/XHR URLs for external osmo subdomains in inline scripts
  //    We inject a fetch interceptor that routes external requests through our proxy
  const fetchInterceptor = `
<script>
// Osmo Proxy: Intercept fetch/XHR to route external osmo domains through proxy
(function() {
  var proxyDomains = ${JSON.stringify(PROXIED_DOMAINS)};
  var _origFetch = window.fetch;
  
  window.fetch = function(input, init) {
    var url;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input && typeof input === 'object' && input.url) {
      url = input.url;
    } else {
      url = String(input);
    }
    
    var modified = false;
    for (var i = 0; i < proxyDomains.length; i++) {
      var domainPattern = 'https://' + proxyDomains[i];
      var httpDomainPattern = 'http://' + proxyDomains[i];
      var doubleSlashPattern = '//' + proxyDomains[i];
      if (url.indexOf(domainPattern) === 0) {
        url = '/__ext__/' + proxyDomains[i] + url.slice(domainPattern.length);
        modified = true;
        break;
      } else if (url.indexOf(httpDomainPattern) === 0) {
        url = '/__ext__/' + proxyDomains[i] + url.slice(httpDomainPattern.length);
        modified = true;
        break;
      } else if (url.indexOf(doubleSlashPattern) === 0) {
        url = '/__ext__/' + proxyDomains[i] + url.slice(doubleSlashPattern.length);
        modified = true;
        break;
      }
    }
    
    if (modified) {
      if (input instanceof Request) {
        var newRequest = new Request(url, input);
        return _origFetch.call(this, newRequest, init);
      }
      return _origFetch.call(this, url, init);
    }
    return _origFetch.call(this, input, init);
  };

  // Also intercept XMLHttpRequest
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url) {
      var urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
      for (var i = 0; i < proxyDomains.length; i++) {
        var domainPattern = 'https://' + proxyDomains[i];
        var httpDomainPattern = 'http://' + proxyDomains[i];
        var doubleSlashPattern = '//' + proxyDomains[i];
        if (urlStr.indexOf(domainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(domainPattern.length);
          break;
        } else if (urlStr.indexOf(httpDomainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(httpDomainPattern.length);
          break;
        } else if (urlStr.indexOf(doubleSlashPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(doubleSlashPattern.length);
          break;
        }
      }
    }
    return _origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>
`;
  $('head').prepend(fetchInterceptor);

  // 10. Inject a small banner so user knows they're on the proxy
  const banner = `
    <div id="osmo-proxy-banner" style="
      position: fixed; 
      bottom: 16px; 
      right: 16px; 
      z-index: 999999;
      background: linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 100%);
      color: #ffa0a0;
      padding: 10px 18px;
      border-radius: 10px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      border: 1px solid rgba(255,160,160,0.2);
      cursor: pointer;
      backdrop-filter: blur(12px);
      transition: opacity 0.3s;
    " onclick="this.style.opacity='0'; setTimeout(()=>this.remove(),300)">
      🔓 Moden Proxy Active — <span style="color:#666">click to dismiss</span>
    </div>
  `;
  $('body').append(banner);

  let finalHtml = $.html();
  
  // Rewrite URLs pointing to proxied domains to go through our proxy
  PROXIED_DOMAINS.forEach(domain => {
    const regex = new RegExp(`https?://${domain.replace(/\./g, '\\.')}`, 'g');
    finalHtml = finalHtml.replace(regex, `/__ext__/${domain}`);
  });

  return finalHtml;
}

// ─── Handle external domain proxy ────────────────────────────────────────────
async function proxyExternal(req, res, domain, extPath) {
  const targetUrl = `https://${domain}${extPath}`;
  const startTime = Date.now();

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Referer': TARGET_ORIGIN + '/',
        'Origin': TARGET_ORIGIN,
      },
      redirect: 'follow',
    };

    // Pass Content-Type if present
    if (req.headers['content-type']) {
      fetchOptions.headers['Content-Type'] = req.headers['content-type'];
    }

    // Read and pass request body for POST/PUT/PATCH
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      fetchOptions.body = Buffer.concat(buffers);
    }

    const response = await fetch(targetUrl, fetchOptions);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const duration = Date.now() - startTime;

    // Forward all response headers we care about
    const respHeaders = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': response.headers.get('cache-control') || 'no-cache',
    };

    const buffer = await response.buffer();
    addLog(req.method, `/__ext__/${domain}${extPath}`, response.status, duration);

    res.writeHead(response.status, respHeaders);
    res.end(buffer);
  } catch (err) {
    const duration = Date.now() - startTime;
    addLog(req.method, `/__ext__/${domain}${extPath}`, 502, duration);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`External proxy error: ${err.message}`);
  }
}

// ─── Handle CSS/JS/Image proxying ────────────────────────────────────────────
async function proxyAsset(res, targetUrl, headers) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': headers['user-agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': headers['accept'] || '*/*',
        'Referer': TARGET_ORIGIN + '/',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });

    const buffer = await response.buffer();
    res.end(buffer);
  } catch (err) {
    res.writeHead(502);
    res.end(`Proxy error: ${err.message}`);
  }
}

// ─── Dashboard UI ────────────────────────────────────────────────────────────
function serveDashboard(res) {
  const cacheEntries = listCacheEntries();
  const cacheCount = cacheEntries.length;
  const cacheSize = cacheEntries.reduce((s, e) => s + (e.size || 0), 0);
  const cacheTTLHours = Math.round(CACHE_TTL / 3600000);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Moden Proxy — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #0a0a0f;
      --bg-secondary: #12121a;
      --bg-card: #16162266;
      --border: rgba(255,255,255,0.06);
      --text-primary: #e8e8f0;
      --text-secondary: #8888a0;
      --text-muted: #555570;
      --accent: #f060a0; /* Changed accent color to pinkish */
      --accent-glow: rgba(240, 96, 160, 0.15);
      --accent-alt: #f0a040;
      --danger: #f06060;
      --radius: 14px;
    }

    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 24px;
      position: relative;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(ellipse at 30% 20%, rgba(240,96,160,0.03) 0%, transparent 50%),
                  radial-gradient(ellipse at 70% 80%, rgba(240,160,64,0.02) 0%, transparent 50%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      width: 100%;
      max-width: 720px;
      position: relative;
      z-index: 1;
    }

    .logo-area {
      text-align: center;
      margin-bottom: 48px;
    }

    .logo-area h1 {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-alt) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 8px;
    }

    .logo-area p {
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 400;
    }

    .input-group {
      display: flex;
      gap: 10px;
      margin-bottom: 32px;
    }

    .input-wrapper {
      flex: 1;
      position: relative;
    }

    .input-wrapper .prefix {
      position: absolute;
      left: 16px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      pointer-events: none;
      white-space: nowrap;
    }

    input[type="text"] {
      width: 100%;
      padding: 14px 16px 14px 200px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text-primary);
      font-family: 'JetBrains Mono', monospace;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    input[type="text"]:focus {
      border-color: rgba(240,96,160,0.3);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }

    input[type="text"]::placeholder {
      color: var(--text-muted);
    }

    .btn {
      padding: 14px 28px;
      border: none;
      border-radius: var(--radius);
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .btn-primary {
      background: linear-gradient(135deg, var(--accent) 0%, #e05090 100%);
      color: #0a0a0f;
      box-shadow: 0 4px 16px rgba(240,96,160,0.2);
    }

    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(240,96,160,0.3);
    }

    .btn-primary:active {
      transform: translateY(0);
    }

    .quick-links {
      margin-bottom: 40px;
    }

    .quick-links h3 {
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    .links-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }

    .link-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      text-decoration: none;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      transition: all 0.2s;
      backdrop-filter: blur(8px);
    }

    .link-card:hover {
      border-color: rgba(240,96,160,0.2);
      background: rgba(240,96,160,0.04);
      transform: translateY(-1px);
    }

    .link-card .icon {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(240,96,160,0.08);
      border-radius: 8px;
      font-size: 16px;
      flex-shrink: 0;
    }

    .log-section {
      margin-top: 16px;
    }

    .log-section h3 {
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin-bottom: 14px;
    }

    .log-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      max-height: 280px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.8;
    }

    .log-container::-webkit-scrollbar { width: 6px; }
    .log-container::-webkit-scrollbar-track { background: transparent; }
    .log-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

    .log-entry { color: var(--text-secondary); }
    .log-entry .method { color: var(--accent); font-weight: 500; }
    .log-entry .path { color: var(--accent-alt); }
    .log-entry .status { font-weight: 500; }
    .log-entry .status.ok { color: var(--accent); }
    .log-entry .status.err { color: var(--danger); }
    .log-entry .time { color: var(--text-muted); }

    .empty-log {
      color: var(--text-muted);
      text-align: center;
      padding: 24px;
      font-style: italic;
    }

    .info-bar {
      margin-top: 40px;
      padding: 16px 20px;
      background: rgba(240,96,160,0.04);
      border: 1px solid rgba(240,96,160,0.1);
      border-radius: 12px;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.7;
    }

    .info-bar code {
      background: rgba(255,255,255,0.06);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--accent);
    }

    /* ─── Cache Section ─── */
    .cache-section { margin-top: 32px; }
    .cache-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    .cache-header h3 {
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
      margin: 0;
    }
    .cache-stats {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-secondary);
    }
    .cache-actions { margin-bottom: 12px; display: flex; gap: 8px; }
    .btn-sm {
      padding: 8px 16px;
      font-size: 12px;
      border-radius: 8px;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    .btn-outline:hover {
      border-color: rgba(240,96,96,0.3);
      color: var(--danger);
      background: rgba(240,96,96,0.05);
    }
    .cache-grid {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 240px;
      overflow-y: auto;
    }
    .cache-grid::-webkit-scrollbar { width: 6px; }
    .cache-grid::-webkit-scrollbar-track { background: transparent; }
    .cache-grid::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    .cache-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 10px;
      backdrop-filter: blur(8px);
      transition: all 0.2s;
    }
    .cache-item:hover { border-color: rgba(240,96,160,0.15); }
    .cache-item-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .cache-path {
      color: var(--accent-alt);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      text-decoration: none;
      font-weight: 500;
    }
    .cache-path:hover { color: var(--accent); }
    .cache-meta { font-size: 11px; color: var(--text-muted); }
    .cache-item-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .btn-icon {
      background: none;
      border: 1px solid transparent;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      font-size: 14px;
      transition: all 0.2s;
    }
    .btn-icon:hover {
      background: rgba(255,255,255,0.05);
      border-color: var(--border);
      color: var(--text-primary);
    }
    .log-cache-tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 600;
      margin-left: 6px;
      display: inline-block;
    }
    .log-cache-hit { background: rgba(240,96,160,0.12); color: var(--accent); }
    .log-cache-miss { background: rgba(240,160,64,0.12); color: var(--accent-alt); }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .container > * {
      animation: fadeIn 0.4s ease-out both;
    }

    .container > *:nth-child(1) { animation-delay: 0s; }
    .container > *:nth-child(2) { animation-delay: 0.05s; }
    .container > *:nth-child(3) { animation-delay: 0.1s; }
    .container > *:nth-child(4) { animation-delay: 0.15s; }
    .container > *:nth-child(5) { animation-delay: 0.2s; }
    .container > *:nth-child(6) { animation-delay: 0.25s; }
    .container > *:nth-child(7) { animation-delay: 0.3s; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-area">
      <h1>🔓 Moden Proxy</h1>
      <p>Browse moden.club without access restrictions</p>
    </div>

    <div class="input-group">
      <div class="input-wrapper">
        <span class="prefix">http://localhost:${PORT}/</span>
        <input type="text" id="pathInput" placeholder="vault" autofocus>
      </div>
      <button class="btn btn-primary" onclick="goToPath()">Browse →</button>
    </div>

    <div class="quick-links">
      <h3>Quick Access</h3>
      <div class="links-grid">
        <a href="/vault" class="link-card">
          <div class="icon">🗄️</div>
          <span>/vault</span>
        </a>
        <a href="/resources" class="link-card">
          <div class="icon">📦</div>
          <span>/resources</span>
        </a>
        <a href="/pricing" class="link-card">
          <div class="icon">💰</div>
          <span>/pricing</span>
        </a>
        <a href="/changelog" class="link-card">
          <div class="icon">📋</div>
          <span>/changelog</span>
        </a>
      </div>
    </div>

    <div class="log-section">
      <h3>Request Log</h3>
      <div class="log-container" id="logContainer">
        <div class="empty-log">No requests yet — browse a page to start</div>
      </div>
    </div>

    <div class="cache-section">
      <div class="cache-header">
        <h3>📦 Cache (${cacheTTLHours}h TTL)</h3>
        <div class="cache-stats" id="cacheStats"></div>
      </div>
      <div class="cache-actions">
        <button class="btn btn-sm btn-outline" onclick="clearAllCache()">🗑️ Clear All Cache</button>
      </div>
      <div class="cache-grid" id="cacheGrid">
        <div class="empty-log">No cached pages yet — browse a page to populate cache</div>
      </div>
    </div>

    <div class="info-bar">
      <strong>How it works:</strong> This proxy fetches pages from <code>osmo.supply</code>, 
      strips Outseta authentication gates, redirect scripts, and <code>&lt;noscript&gt;</code> 
      fallbacks, injects a mock <code>Outseta</code> object, and proxies external subdomain 
      requests to avoid CORS errors. Pages are <strong>cached locally</strong> for ${cacheTTLHours}h — 
      cached pages generate <strong>zero requests</strong> to Osmo's servers.
    </div>
  </div>

  <script>
    function goToPath() {
      var path = document.getElementById('pathInput').value.trim();
      if (path) {
        window.location.href = '/' + path.replace(/^\\/+/, '');
      }
    }

    document.getElementById('pathInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') goToPath();
    });

    // ─── Request Log ───────────────────────────────────────────────
    async function fetchLogs() {
      try {
        var res = await fetch('/__proxy__/logs');
        var logs = await res.json();
        var container = document.getElementById('logContainer');
        
        if (logs.length === 0) {
          container.innerHTML = '<div class="empty-log">No requests yet — browse a page to start</div>';
          return;
        }

        container.innerHTML = logs.slice(-50).map(function(l) {
          var statusClass = l.status < 400 ? 'ok' : 'err';
          var pathStr = l.path;
          var cacheTag = '';
          if (l.path.indexOf('[CACHE]') !== -1) {
            pathStr = l.path.replace(' [CACHE]', '');
            cacheTag = '<span class="log-cache-tag log-cache-hit">CACHE</span>';
          } else if (l.path.indexOf('[FRESH]') !== -1) {
            pathStr = l.path.replace(' [FRESH]', '');
            cacheTag = '<span class="log-cache-tag log-cache-miss">FRESH</span>';
          }
          return '<div class="log-entry">'
            + '<span class="time">' + l.time + '</span> '
            + '<span class="method">' + l.method + '</span> '
            + '<span class="path">' + pathStr + '</span>' + cacheTag + ' → '
            + '<span class="status ' + statusClass + '">' + l.status + '</span> '
            + '<span class="time">' + l.duration + 'ms</span>'
            + '</div>';
        }).join('');
        
        container.scrollTop = container.scrollHeight;
      } catch(e) {}
    }

    // ─── Cache Management ──────────────────────────────────────────
    async function fetchCacheStatus() {
      try {
        var res = await fetch('/__proxy__/cache');
        var items = await res.json();
        var grid = document.getElementById('cacheGrid');
        var stats = document.getElementById('cacheStats');
        
        if (items.length === 0) {
          grid.innerHTML = '<div class="empty-log">No cached pages yet — browse a page to populate cache</div>';
          stats.textContent = '';
          return;
        }
        
        var totalSize = items.reduce(function(s, i) { return s + (i.size || 0); }, 0);
        stats.innerHTML = items.length + ' pages · ' + formatBytes(totalSize);
        
        grid.innerHTML = items.map(function(item) {
          var expiresMin = Math.round(item.expiresIn / 60000);
          var expiresStr = expiresMin > 60 
            ? Math.round(expiresMin / 60) + 'h ' + (expiresMin % 60) + 'm'
            : expiresMin + 'm';
          var cachedTime = new Date(item.cachedAt).toLocaleTimeString('en-US', { hour12: false });
          return '<div class="cache-item">'
            + '<div class="cache-item-info">'
            + '<a href="' + item.path + '" class="cache-path">' + item.path + '</a>'
            + '<span class="cache-meta">Cached ' + cachedTime + ' · Expires in ' + expiresStr + '</span>'
            + '</div>'
            + '<div class="cache-item-actions">'
            + '<button class="btn-icon" data-action="refresh" data-path="' + item.path + '" title="Force refresh">🔄</button>'
            + '<button class="btn-icon" data-action="clear" data-path="' + item.path + '" title="Clear">✕</button>'
            + '</div>'
            + '</div>';
        }).join('');
      } catch(e) {}
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function clearAllCache() {
      await fetch('/__proxy__/cache/clear');
      fetchCacheStatus();
    }

    async function clearCachePage(pagePath) {
      await fetch('/__proxy__/cache/clear?path=' + encodeURIComponent(pagePath));
      fetchCacheStatus();
    }

    function refreshPage(pagePath) {
      window.open(pagePath + '?_refresh', '_blank');
      setTimeout(fetchCacheStatus, 1500);
    }

    // Event delegation for cache item buttons
    document.getElementById('cacheGrid').addEventListener('click', function(e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var p = btn.dataset.path;
      if (action === 'refresh') refreshPage(p);
      if (action === 'clear') clearCachePage(p);
    });

    // Start polling
    setInterval(fetchLogs, 2000);
    fetchLogs();
    setInterval(fetchCacheStatus, 3000);
    fetchCacheStatus();
  </script>
</body>
</html>`;
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── Request logs ────────────────────────────────────────────────────────────
const requestLogs = [];

function addLog(method, path, status, duration) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  requestLogs.push({ time, method, path, status, duration });
  if (requestLogs.length > 200) requestLogs.shift();
  
  const statusIcon = status < 400 ? '✅' : '❌';
  const cacheIcon = path.includes('[CACHE]') ? ' 💾' : '';
  console.log(`  ${statusIcon}${cacheIcon} ${status} ${method} ${path} (${duration}ms)`);
}

// ─── Main Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const reqPath = reqUrl.pathname + reqUrl.search;

  // Handle CORS preflight for all routes
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Dashboard
  if (reqPath === '/' || reqPath === '/__proxy__') {
    return serveDashboard(res);
  }

  // Block Cloudflare Analytics / RUM tracking to prevent 405 Method Not Allowed errors
  if (reqPath.startsWith('/cdn-cgi/rum')) {
    const duration = Date.now() - startTime;
    addLog(req.method, reqPath + ' [BLOCKED]', 200, duration);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end('{"status": "ok"}');
  }

  // Log API
  if (reqPath === '/__proxy__/logs') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(requestLogs.slice(-50)));
  }

  // Cache API - list cached pages
  if (reqPath === '/__proxy__/cache') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(listCacheEntries()));
  }

  // Cache API - clear cache
  if (reqUrl.pathname === '/__proxy__/cache/clear') {
    const clearPath = reqUrl.searchParams.get('path');
    clearCacheEntry(clearPath || null);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ 
      success: true, 
      message: clearPath ? 'Cleared cache for ' + clearPath : 'All cache cleared' 
    }));
  }

  // ─── External domain proxy: /__ext__/{domain}/{path} ───────────────────
  const extMatch = reqPath.match(/^\/__ext__\/([^/]+)(\/.*)?$/);
  if (extMatch) {
    const domain = extMatch[1];
    const extPath = (extMatch[2] || '/') + (reqUrl.search || '');
    return proxyExternal(req, res, domain, extPath);
  }

  // ─── Main proxy ────────────────────────────────────────────
  let proxyReqPath = reqPath;
  // Bypass Moden's Webflow/Supabase edge router by adding a double slash
  if (proxyReqPath.startsWith('/resource/') || proxyReqPath.startsWith('/tools/')) {
    proxyReqPath = '/' + proxyReqPath;
  }
  const targetUrl = TARGET_ORIGIN + proxyReqPath;

  // Check cache BEFORE any network request to Osmo (zero footprint)
  const forceRefresh = reqUrl.searchParams.has('_refresh');
  if (!forceRefresh && isCacheValid(reqUrl.pathname)) {
    const cached = readCache(reqUrl.pathname);
    if (cached) {
      const duration = Date.now() - startTime;
      addLog(req.method, reqUrl.pathname + ' [CACHE]', 200, duration);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Osmo-Cache': 'HIT',
        'X-Osmo-Cached-At': cached.meta.cachedAt,
      });
      return res.end(cached.html);
    }
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': TARGET_ORIGIN + '/',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';
    const duration = Date.now() - startTime;

    // Only process HTML
    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = stripProtection(html, reqPath);
      
      // Save to cache for future zero-footprint access
      writeCache(reqUrl.pathname, html);
      
      addLog(req.method, reqUrl.pathname + ' [FRESH]', response.status, duration);
      
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-Osmo-Cache': 'MISS',
      });
      res.end(html);
    } 
    // CSS — proxy as-is
    else if (contentType.includes('text/css')) {
      const css = await response.text();
      addLog(req.method, reqPath, response.status, duration);
      res.writeHead(response.status, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(css);
    }
    // JS — proxy as-is
    else if (contentType.includes('javascript')) {
      const js = await response.text();
      addLog(req.method, reqPath, response.status, duration);
      res.writeHead(response.status, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(js);
    }
    // Other assets: proxy as-is
    else {
      await proxyAsset(res, targetUrl, req.headers);
      addLog(req.method, reqPath, response.status, duration);
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    addLog(req.method, reqPath, 502, duration);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy Error: ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║                                              ║');
  console.log(`  ║   🔓 Osmo Proxy running on port ${PORT}         ║`);
  console.log('  ║                                              ║');
  console.log(`  ║   Dashboard:  http://localhost:${PORT}           ║`);
  console.log(`  ║   Vault:      http://localhost:${PORT}/vault     ║`);
  console.log('  ║                                              ║');
  console.log('  ║   ✓ Outseta protection stripped              ║');
  console.log('  ║   ✓ Outseta mock injected                   ║');
  console.log('  ║   ✓ External domains proxied (CORS fix)     ║');
  console.log('  ║   ✓ Fetch/XHR interceptor active            ║');
  console.log('  ║   ✓ Disk cache enabled (24h TTL)            ║');
  console.log('  ║                                              ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log(`  📦 Cache dir: ${CACHE_DIR}`);
  console.log(`  ⏱️  Cache TTL: ${CACHE_TTL / 3600000}h`);
  console.log('');
});
