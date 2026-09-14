const http = require('http');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const jsBeautify = require('js-beautify');

const PORT = process.env.PORT || 4000;
const CACHE_TTL = 24 * 60 * 60 * 1000;

const requestLogs = [];

function addLog(method, path, status, duration, details) {
  const now = new Date();
  const time = now.toLocaleTimeString('en-US', { hour12: false });
  requestLogs.push({
    id: Math.random().toString(36).substring(2, 9),
    time,
    method,
    path,
    status,
    duration,
    details: {
      reqHeaders: details?.reqHeaders || {},
      resHeaders: details?.resHeaders || {},
      reqBody: (details?.reqBody || '').slice(0, 1000),
      resBody: (details?.resBody || '').slice(0, 1000)
    }
  });
  if (requestLogs.length > 200) requestLogs.shift();
  
  const statusIcon = status < 400 ? '✅' : '❌';
  const cacheIcon = path.includes('[CACHE]') ? ' 💾' : '';
  console.log(`  ${statusIcon}${cacheIcon} ${status} ${method} ${path} (${duration}ms)`);
}

// ─── OSMO CONFIG ────────────────────────────────────────────────────────────
const TARGET_OSMO = 'https://www.osmo.supply';
const CACHE_DIR_OSMO = path.join(__dirname, '.cache_osmo');
let PROXIED_DOMAINS_OSMO = [
  'updates.osmo.supply',
  'config.outseta.com',
  'cdn.outseta.com',
  'osmo.outseta.com',
  'cdn.prod.website-files.com',
  'osmo.b-cdn.net',
  'slater.app',
  'annnimate.com',
  'annnimate.b-cdn.net',
];

// ─── MODEN CONFIG ───────────────────────────────────────────────────────────
const TARGET_MODEN = 'https://moden.club';
const CACHE_DIR_MODEN = path.join(__dirname, '.cache_moden');
let PROXIED_DOMAINS_MODEN = [
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
  'annnimate.com',
  'annnimate.b-cdn.net',
];

// ─── ANNNIMATE CONFIG ───────────────────────────────────────────────────────
const TARGET_ANNNIMATE = 'https://annnimate.com';
const CACHE_DIR_ANNNIMATE = path.join(__dirname, '.cache_annnimate');
let PROXIED_DOMAINS_ANNNIMATE = [
  'annnimate.b-cdn.net',
];

// ─── ANNNIMATE SUPABASE (source code extraction) ────────────────────────────
const SUPABASE_URL = 'https://awfklrxbaytuhycequvl.supabase.co';
let SUPABASE_ANON_KEY = null;

// In-memory cache: key → { data, ts }. Avoids repeated Supabase hits.
const _sbCache = new Map();
const SB_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours (was 6h)
const SB_MIN_INTERVAL = 2000; // minimum ms between Supabase requests (was 1.5s)
let _sbLastRequest = 0;
const SB_CACHE_FILE = path.join(__dirname, '.cache_annnimate', '_supabase_cache.json');

// Load persisted Supabase cache from disk on startup
function loadSbCache() {
  try {
    if (fs.existsSync(SB_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(SB_CACHE_FILE, 'utf-8'));
      for (const [k, v] of Object.entries(data)) {
        if ((Date.now() - v.ts) < SB_CACHE_TTL) _sbCache.set(k, v);
      }
      console.log('  📦 Loaded ' + _sbCache.size + ' Supabase cache entries from disk');
    }
  } catch (e) {}
}
function saveSbCache() {
  try {
    ensureCacheDir(CACHE_DIR_ANNNIMATE);
    const obj = {};
    _sbCache.forEach((v, k) => { obj[k] = v; });
    fs.writeFileSync(SB_CACHE_FILE, JSON.stringify(obj), 'utf-8');
  } catch (e) {}
}

// Rotate User-Agents to reduce fingerprinting
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
];
function randomUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }

async function getSupabaseKey() {
  if (SUPABASE_ANON_KEY) return SUPABASE_ANON_KEY;
  try {
    const r = await fetch(TARGET_ANNNIMATE, { timeout: 10000, headers: { 'User-Agent': randomUA() } });
    const html = await r.text();
    const chunks = html.match(/\/_next\/static\/chunks\/[^"'\s]+\.js/g) || [];
    for (const chunk of chunks.slice(0, 40)) {
      const jr = await fetch(TARGET_ANNNIMATE + chunk, { timeout: 8000, headers: { 'User-Agent': randomUA() } });
      const js = await jr.text();
      const key = js.match(/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
      if (key) { SUPABASE_ANON_KEY = key[0]; return SUPABASE_ANON_KEY; }
    }
  } catch (e) { console.error('  ⚠️ Supabase key fetch failed:', e.message); }
  return null;
}

async function supabaseQuery(table, params) {
  const cacheKey = table + '?' + params;

  // Check memory cache
  const cached = _sbCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SB_CACHE_TTL) return cached.data;

  // Rate limit
  const wait = SB_MIN_INTERVAL - (Date.now() - _sbLastRequest);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const key = await getSupabaseKey();
  if (!key) throw new Error('Supabase anon key not available');
  const url = SUPABASE_URL + '/rest/v1/' + table + '?' + params;
  const r = await fetch(url, {
    headers: {
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Accept': 'application/json',
      'User-Agent': randomUA(),
    },
    timeout: 10000,
  });
  _sbLastRequest = Date.now();
  if (r.status !== 200) throw new Error('Supabase returned ' + r.status);
  const data = await r.json();

  // Store in memory + persist to disk
  _sbCache.set(cacheKey, { data, ts: Date.now() });
  saveSbCache();
  return data;
}

// ─── DOMAIN DISCOVERY & HEADERS FORWARDING ──────────────────────────────────
const reportedDomains = {
  osmo: new Set(),
  moden: new Set(),
  annnimate: new Set()
};

function getForwardHeaders(reqHeaders, targetOrigin) {
  const cleanHeaders = {};
  const headersToForward = [
    'user-agent',
    'accept',
    'accept-language',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-user',
    'upgrade-insecure-requests',
    'content-type'
  ];
  headersToForward.forEach(h => {
    if (reqHeaders[h]) cleanHeaders[h] = reqHeaders[h];
  });
  // Fallback to rotated UA if client didn't send one (e.g. curl)
  if (!cleanHeaders['user-agent']) cleanHeaders['user-agent'] = randomUA();
  cleanHeaders['referer'] = targetOrigin + '/';
  cleanHeaders['origin'] = targetOrigin;
  return cleanHeaders;
}

// ─── CACHE SYSTEM ───────────────────────────────────────────────────────────
function ensureCacheDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureCacheDir(CACHE_DIR_OSMO);
ensureCacheDir(CACHE_DIR_ANNNIMATE);
ensureCacheDir(CACHE_DIR_MODEN);
loadSbCache(); // Restore persisted Supabase cache

function getCacheKey(urlPath) {
  return encodeURIComponent(urlPath).replace(/%/g, '_');
}

function getCachePath(urlPath, cacheDir) {
  return path.join(cacheDir, getCacheKey(urlPath) + '.html');
}

function getCacheMetaPath(urlPath, cacheDir) {
  return path.join(cacheDir, getCacheKey(urlPath) + '.meta.json');
}

function isCacheValid(urlPath, cacheDir) {
  const metaPath = getCacheMetaPath(urlPath, cacheDir);
  if (!fs.existsSync(metaPath)) return false;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return (Date.now() - meta.timestamp) < CACHE_TTL;
  } catch {
    return false;
  }
}

function readCache(urlPath, cacheDir) {
  const cachePath = getCachePath(urlPath, cacheDir);
  const metaPath = getCacheMetaPath(urlPath, cacheDir);
  if (!fs.existsSync(cachePath) || !fs.existsSync(metaPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    const html = fs.readFileSync(cachePath, 'utf-8');
    return { html, meta };
  } catch {
    return null;
  }
}

function writeCache(urlPath, html, cacheDir) {
  const cachePath = getCachePath(urlPath, cacheDir);
  const metaPath = getCacheMetaPath(urlPath, cacheDir);
  const meta = {
    path: urlPath,
    timestamp: Date.now(),
    cachedAt: new Date().toISOString(),
    size: Buffer.byteLength(html, 'utf-8'),
  };
  fs.writeFileSync(cachePath, html, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
}

function clearCacheEntry(urlPath, cacheDir) {
  if (urlPath) {
    const cachePath = getCachePath(urlPath, cacheDir);
    const metaPath = getCacheMetaPath(urlPath, cacheDir);
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } else {
    if (!fs.existsSync(cacheDir)) return;
    const files = fs.readdirSync(cacheDir);
    files.forEach(f => fs.unlinkSync(path.join(cacheDir, f)));
  }
}

// ─── SOURCE EXTRACTION HELPER ───────────────────────────────────────────────
function extractSource(html) {
  const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  const css = jsBeautify.css(styleMatch ? styleMatch[1].trim() : '', { indent_size: 2 });

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let componentHtml = bodyMatch ? bodyMatch[1] : '';
  componentHtml = jsBeautify.html(
    componentHtml.replace(/<script[\s\S]*?<\/script>/g, '').trim(),
    { indent_size: 2, wrap_line_length: 0 }
  );

  const scripts = [];
  const scriptRegex = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = scriptRegex.exec(html)) !== null) {
    if (m[1].trim().length > 100) scripts.push(m[1].trim());
  }
  scripts.sort((a, b) => b.length - a.length);

  const componentJs = jsBeautify.js(
    scripts.find(s => s.includes('SCRIPT_DEPS')) || scripts[0] || '',
    { indent_size: 2 }
  );
  const depsMatch = componentJs.match(/SCRIPT_DEPS\s*=\s*\[([^\]]+)\]/);
  const deps = depsMatch ? depsMatch[1].replace(/"/g, '').split(',').map(s => s.trim()) : [];

  const anmAttrs = {};
  const attrRegex = /data-anm-([a-z-]+)="([^"]*)"/g;
  let am;
  while ((am = attrRegex.exec(componentHtml)) !== null) {
    anmAttrs[am[1]] = am[2];
  }

  return { css, html: componentHtml, js: componentJs, deps, anmAttributes: anmAttrs };
}

// ─── OUTSETA MOCK ───────────────────────────────────────────────────────────
const OUTSETA_MOCK_SCRIPT = `
<script>
// Master Proxy: Mock Outseta with premium active subscription
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
  
  window.o_options = window.o_options || {};
})();
</script>
`;

// ─── STRIPPING LOGIC (OSMO) ─────────────────────────────────────────────────
function stripProtectionOsmo(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('noscript').each((_, el) => {
    const content = $(el).html();
    if (content && content.includes('no-access')) $(el).remove();
  });

  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes('window.Outseta') && text.includes('window.location')) { $(el).remove(); return; }
    if (text.includes('/no-access') && text.includes('location.replace')) { $(el).remove(); return; }
    if (text.includes('postLogoutRedirect') && text.includes('location.replace')) { $(el).remove(); return; }
  });

  $('meta[name="robots"][content="noindex"]').remove();
  $('script[src*="outseta.min.js"]').remove();
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes("var o_options") && text.includes("outseta.com")) $(el).remove();
    if (text.includes('Outseta.on(') && text.includes('signup')) $(el).remove();
  });

  $('head').prepend(OUTSETA_MOCK_SCRIPT);
  $('[data-o-anonymous]').removeAttr('data-o-anonymous');
  $('[data-o-auth]').removeAttr('data-o-auth');
  $('[data-o-logout]').removeAttr('data-o-logout');

  let finalHtml = $.html();
  PROXIED_DOMAINS_OSMO.forEach(domain => {
    const regex = new RegExp("https?://" + domain.replace(/\\./g, "\\."), "g");
    finalHtml = finalHtml.replace(regex, "/__ext__/" + domain);
  });
  
  const inject = cheerio.load(finalHtml, { decodeEntities: false });
  inject('a[href]').each((_, el) => {
    const href = inject(el).attr('href');
    if (href && href.startsWith(TARGET_OSMO)) inject(el).attr('href', href.replace(TARGET_OSMO, ''));
  });

  const fetchInterceptor = `
<script>
(function() {
  var proxyDomains = ${JSON.stringify(PROXIED_DOMAINS_OSMO)};
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
    
    var isExternal = false;
    var extDomain = '';
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0 || url.indexOf('//') === 0) {
      var match = url.match(/^https?:\\/\\/([^\\/]+)/) || url.match(/^\\/\\/([^\\/]+)/);
      if (match) {
        extDomain = match[1];
        if (extDomain !== window.location.host && extDomain !== 'localhost' && extDomain !== '127.0.0.1') {
          isExternal = true;
        }
      }
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
    
    if (isExternal && !modified && extDomain) {
      _origFetch.call(window, '/__proxy__/domains/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: extDomain })
      }).catch(function() {});
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
  
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url) {
      var urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
      var isExternal = false;
      var extDomain = '';
      if (urlStr.indexOf('http://') === 0 || urlStr.indexOf('https://') === 0 || urlStr.indexOf('//') === 0) {
        var match = urlStr.match(/^https?:\\/\\/([^\\/]+)/) || urlStr.match(/^\\/\\/([^\\/]+)/);
        if (match) {
          extDomain = match[1];
          if (extDomain !== window.location.host && extDomain !== 'localhost' && extDomain !== '127.0.0.1') {
            isExternal = true;
          }
        }
      }

      var modified = false;
      for (var i = 0; i < proxyDomains.length; i++) {
        var domainPattern = 'https://' + proxyDomains[i];
        var httpDomainPattern = 'http://' + proxyDomains[i];
        var doubleSlashPattern = '//' + proxyDomains[i];
        if (urlStr.indexOf(domainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(domainPattern.length);
          modified = true;
          break;
        } else if (urlStr.indexOf(httpDomainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(httpDomainPattern.length);
          modified = true;
          break;
        } else if (urlStr.indexOf(doubleSlashPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(doubleSlashPattern.length);
          modified = true;
          break;
        }
      }

      if (isExternal && !modified && extDomain) {
        _origFetch.call(window, '/__proxy__/domains/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: extDomain })
        }).catch(function() {});
      }
    }
    return _origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>`;
  inject('head').prepend(fetchInterceptor);

  const banner = `
    <div id="proxy-banner" style="position:fixed;bottom:16px;right:16px;z-index:999999;background:linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 100%);color:#a0ffa0;padding:10px 18px;border-radius:10px;font-family:'SF Mono', monospace;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,0.5);border:1px solid rgba(160,255,160,0.2);cursor:pointer;backdrop-filter:blur(12px);transition:opacity 0.3s;" onclick="window.location.href='/__dashboard'">
      🔓 Osmo Proxy Active — <span style="color:#fff; text-decoration:underline;">Switch Site</span>
    </div>
  `;
  inject('body').append(banner);
  return inject.html();
}

// ─── STRIPPING LOGIC (MODEN) ────────────────────────────────────────────────
function stripProtectionModen(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  $('noscript').each((_, el) => {
    const content = $(el).html();
    if (content && content.includes('no-access')) $(el).remove();
  });

  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes('window.Outseta') && text.includes('window.location')) { $(el).remove(); return; }
    if (text.includes('/no-access') && text.includes('location.replace')) { $(el).remove(); return; }
    if (text.includes('postLogoutRedirect') && text.includes('location.replace')) { $(el).remove(); return; }
  });

  $('meta[name="robots"][content="noindex"]').remove();
  $('script[src*="outseta.min.js"]').remove();
  $('script').each((_, el) => {
    const text = $(el).html() || '';
    if (text.includes("var o_options") && text.includes("outseta.com")) $(el).remove();
    if (text.includes('Outseta.on(') && text.includes('signup')) $(el).remove();
  });

  $('html').attr('data-auth', 'subscribed');
  $('head').prepend(OUTSETA_MOCK_SCRIPT);
  
  $('[data-o-anonymous]').removeAttr('data-o-anonymous');
  $('[data-o-auth]').removeAttr('data-o-auth');
  $('[data-o-logout]').removeAttr('data-o-logout');

  let finalHtml = $.html();
  PROXIED_DOMAINS_MODEN.forEach(domain => {
    const regex = new RegExp("https?://" + domain.replace(/\\./g, "\\."), "g");
    finalHtml = finalHtml.replace(regex, "/__ext__/" + domain);
  });
  
  const inject = cheerio.load(finalHtml, { decodeEntities: false });
  inject('a[href]').each((_, el) => {
    const href = inject(el).attr('href');
    if (href && href.startsWith(TARGET_MODEN)) inject(el).attr('href', href.replace(TARGET_MODEN, ''));
  });

  const fetchInterceptor = `
<script>
(function() {
  var proxyDomains = ${JSON.stringify(PROXIED_DOMAINS_MODEN)};
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
    
    var isExternal = false;
    var extDomain = '';
    if (url.indexOf('http://') === 0 || url.indexOf('https://') === 0 || url.indexOf('//') === 0) {
      var match = url.match(/^https?:\\/\\/([^\\/]+)/) || url.match(/^\\/\\/([^\\/]+)/);
      if (match) {
        extDomain = match[1];
        if (extDomain !== window.location.host && extDomain !== 'localhost' && extDomain !== '127.0.0.1') {
          isExternal = true;
        }
      }
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
    
    if (isExternal && !modified && extDomain) {
      _origFetch.call(window, '/__proxy__/domains/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: extDomain })
      }).catch(function() {});
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
  
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url) {
      var urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : String(url));
      var isExternal = false;
      var extDomain = '';
      if (urlStr.indexOf('http://') === 0 || urlStr.indexOf('https://') === 0 || urlStr.indexOf('//') === 0) {
        var match = urlStr.match(/^https?:\\/\\/([^\\/]+)/) || urlStr.match(/^\\/\\/([^\\/]+)/);
        if (match) {
          extDomain = match[1];
          if (extDomain !== window.location.host && extDomain !== 'localhost' && extDomain !== '127.0.0.1') {
            isExternal = true;
          }
        }
      }

      var modified = false;
      for (var i = 0; i < proxyDomains.length; i++) {
        var domainPattern = 'https://' + proxyDomains[i];
        var httpDomainPattern = 'http://' + proxyDomains[i];
        var doubleSlashPattern = '//' + proxyDomains[i];
        if (urlStr.indexOf(domainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(domainPattern.length);
          modified = true;
          break;
        } else if (urlStr.indexOf(httpDomainPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(httpDomainPattern.length);
          modified = true;
          break;
        } else if (urlStr.indexOf(doubleSlashPattern) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(doubleSlashPattern.length);
          modified = true;
          break;
        }
      }

      if (isExternal && !modified && extDomain) {
        _origFetch.call(window, '/__proxy__/domains/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: extDomain })
        }).catch(function() {});
      }
    }
    return _origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>`;
  inject('head').prepend(fetchInterceptor);

  const banner = `
    <div id="proxy-banner" style="position:fixed;bottom:16px;right:16px;z-index:999999;background:linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 100%);color:#f060a0;padding:10px 18px;border-radius:10px;font-family:'SF Mono', monospace;font-size:12px;box-shadow:0 4px 24px rgba(0,0,0,0.5);border:1px solid rgba(240,96,160,0.2);cursor:pointer;backdrop-filter:blur(12px);transition:opacity 0.3s;" onclick="window.location.href='/__dashboard'">
      🔓 Moden Proxy Active — <span style="color:#fff; text-decoration:underline;">Switch Site</span>
    </div>
  `;
  inject('body').append(banner);
  return inject.html();
}

// ─── STRIPPING LOGIC (ANNNIMATE) ────────────────────────────────────────────
function stripProtectionAnnnimate(html) {
  // Annnimate is Next.js RSC. MUST NOT rewrite URLs in HTML — the inline RSC
  // flight data contains serialized JSON with URLs; blanket regex replacement
  // corrupts it and causes hydration errors. The full reverse proxy already
  // handles all requests, so no URL rewriting is needed in the HTML.

  // 1. Fetch interceptor for CORS domains
  const fetchInterceptor = `
<script>
(function() {
  var proxyDomains = ${JSON.stringify(PROXIED_DOMAINS_ANNNIMATE)};
  var _origFetch = window.fetch;
  window.fetch = function(input, init) {
    var url;
    if (typeof input === 'string') url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && typeof input === 'object' && input.url) url = input.url;
    else url = String(input);
    for (var i = 0; i < proxyDomains.length; i++) {
      var pat = 'https://' + proxyDomains[i];
      if (url.indexOf(pat) === 0) {
        url = '/__ext__/' + proxyDomains[i] + url.slice(pat.length);
        if (input instanceof Request) return _origFetch.call(this, new Request(url, input), init);
        return _origFetch.call(this, url, init);
      }
    }
    if (url.match(/^https?:\\/\\//)) {
      var m = url.match(/^https?:\\/\\/([^\\/]+)/);
      if (m && m[1] !== window.location.host) {
        _origFetch.call(window, '/__proxy__/domains/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: m[1] })
        }).catch(function() {});
      }
    }
    return _origFetch.call(this, input, init);
  };
  var _origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (url) {
      var urlStr = typeof url === 'string' ? url : String(url);
      for (var i = 0; i < proxyDomains.length; i++) {
        var pat = 'https://' + proxyDomains[i];
        if (urlStr.indexOf(pat) === 0) {
          url = '/__ext__/' + proxyDomains[i] + urlStr.slice(pat.length);
          break;
        }
      }
    }
    return _origOpen.apply(this, [method, url].concat(Array.prototype.slice.call(arguments, 2)));
  };
})();
</script>`;

  // 2. Unlock + banner script — handles SPA navigation via pushState interception
  const proxyScript = `<script>
(function() {
  'use strict';

  var KITS = {
    reveal: ['logo-draw-split','counter-columns','mosaic-dissolve','logo-fill-cover','image-cycle-zoom','image-trail-loader','grid-flash-cover','composing-grid','hero-marquee','flow-field','fractal-glass-hero','tile-orb','depth-parallax-hero'],
    menu: ['accordion','preview-index','curtain','tile-grid','split-screen','context-shift','push-down','island','pillar','stacked-drawer']
  };

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Highlight data-anm-* attribute values in escaped HTML
  var HL_STYLE = 'background:rgba(96,208,240,0.15);color:#60d0f0;border-radius:2px;padding:0 2px';
  var HL_CHANGED = 'background:rgba(96,240,144,0.25);color:#60f090;border-radius:2px;padding:0 2px;transition:background 0.6s';
  function highlightAttrs(escaped, changed) {
    // Match data-anm-*="value" — esc() doesn't encode quotes, so match raw "
    return escaped.replace(/(data-anm-[a-z-]+)="([^"]*)"/g, function(m, attr, val) {
      var isChanged = changed && changed[attr];
      var style = isChanged ? HL_CHANGED : HL_STYLE;
      return '<span style="color:#f0a060">' + attr + '</span>="<span style="' + style + '">' + val + '</span>"';
    });
  }

  // Reusable code viewer builder
  var TAB_STYLE = 'padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-family:monospace;border:1px solid ';
  var TAB_ACTIVE = TAB_STYLE + 'rgba(96,208,240,0.3);background:rgba(96,208,240,0.15);color:#60d0f0';
  var TAB_INACTIVE = TAB_STYLE + 'rgba(255,255,255,0.1);background:transparent;color:#999';
  var COPY_STYLE = 'margin-left:auto;' + TAB_STYLE + 'rgba(96,240,144,0.3);background:rgba(96,240,144,0.1);color:#60f090';
  var PRE_STYLE = 'padding:12px 16px;margin:0;font-size:12px;line-height:1.6;font-family:JetBrains Mono,SF Mono,monospace;white-space:pre;overflow:auto;max-height:500px;color:#d4d4d4;background:#0a0a0f;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;position:relative';

  function buildFullPage(data) {
    // The JS (boot script) already loads GSAP deps via SCRIPT_DEPS internally,
    // so we don't need separate <script src> tags. Just combine CSS + HTML + JS.
    return '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n<meta charset="UTF-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\\n<style>\\n'
      + data.css
      + '\\n</style>\\n</head>\\n<body>\\n'
      + data.html
      + '\\n<script>\\n'
      + data.js
      + '\\n<\\/script>\\n</body>\\n</html>';
  }

  function buildCodeViewer(id, data) {
    data._full = buildFullPage(data);
    var bar = '<div style="display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);position:sticky;top:0;z-index:1;flex-wrap:wrap">'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'full\\')" class="' + id + '-tab" style="' + TAB_ACTIVE + '">⚡ Full</button>'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'html\\')" class="' + id + '-tab" style="' + TAB_INACTIVE + '">HTML</button>'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'css\\')" class="' + id + '-tab" style="' + TAB_INACTIVE + '">CSS</button>'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'js\\')" class="' + id + '-tab" style="' + TAB_INACTIVE + '">JS</button>'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'react\\')" class="' + id + '-tab" style="' + TAB_STYLE + 'rgba(97,218,251,0.3);background:rgba(97,218,251,0.1);color:#61dafb">⚛ React</button>'
      + '<button onclick="switchTab(\\'' + id + '\\',this,\\'vue\\')" class="' + id + '-tab" style="' + TAB_STYLE + 'rgba(66,184,131,0.3);background:rgba(66,184,131,0.1);color:#42b883">◆ Vue</button>'
      + '<button onclick="copyCodeBlock(\\'' + id + '\\')" style="' + COPY_STYLE + '">📋 Copy</button>'
      + '</div>';
    var pre = '<pre data-lenis-prevent style="' + PRE_STYLE + '"><code id="' + id + '-code">' + highlightAttrs(esc(data._full)) + '</code></pre>';
    return bar + pre;
  }

  // Shared tab switch + copy handlers
  window.switchTab = function(id, btn, tab) {
    var code = document.getElementById(id + '-code');
    var store = window['_anmData_' + id];
    if (!code || !store) return;

    if ((tab === 'react' || tab === 'vue') && !store['_' + tab]) {
      var slug = store._slug || window.location.pathname.match(/[\\w-]+$/)?.[0];
      code.textContent = 'Loading ' + tab + ' source...';
      fetch('/__proxy__/annnimate/original?component=' + slug + '&format=' + tab)
        .then(function(r) { return r.text(); })
        .then(function(t) { store['_' + tab] = t; code.textContent = t; })
        .catch(function(e) { code.textContent = 'Error: ' + e.message; });
    } else if (tab === 'react' || tab === 'vue') {
      code.textContent = store['_' + tab];
    } else if (tab === 'full') {
      // Full tab: use innerHTML with highlighted data-anm-* attributes
      code.innerHTML = highlightAttrs(esc(store._full), store._changed);
    } else if (tab === 'html') {
      code.innerHTML = highlightAttrs(esc(store.html), store._changed);
    } else if (tab === 'css') {
      code.textContent = store.css;
    } else if (tab === 'js') {
      code.textContent = store.js;
    }

    document.querySelectorAll('.' + id + '-tab').forEach(function(b) { b.style.cssText = TAB_INACTIVE; });
    btn.style.cssText = TAB_ACTIVE;
  };
  window.copyCodeBlock = function(id) {
    var code = document.getElementById(id + '-code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(function() {
      var btns = document.querySelectorAll('button');
      for (var b of btns) { if (b.textContent === '📋 Copy' && b.onclick && b.getAttribute('onclick').indexOf(id) !== -1) { b.textContent = '✅ Copied!'; setTimeout(function() { b.textContent = '📋 Copy'; }, 2000); break; } }
    });
  };

  // ─── Force full-page navigation ───
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || a.target === '_blank') return;
    e.preventDefault();
    e.stopPropagation();
    window.location.href = href;
  }, true);

  // ─── Banner ───
  function initBanner() {
    var path = window.location.pathname;
    var animMatch = path.match(/^\\/animations\\/([\\w-]+)$/);
    var kitMatch = path.match(/^\\/kits\\/([\\w-]+)$/);
    var slug = animMatch ? animMatch[1] : null;
    var kit = kitMatch ? kitMatch[1] : null;

    var el = document.createElement('div');
    el.id = 'proxy-banner';
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:linear-gradient(135deg,#0f0f0f 0%,#1a1a2e 100%);color:#60d0f0;padding:10px 14px;border-radius:10px;font-family:SF Mono,monospace;font-size:11px;box-shadow:0 4px 24px rgba(0,0,0,0.5);border:1px solid rgba(96,208,240,0.2);backdrop-filter:blur(12px);display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:640px;line-height:1.8;';

    var h = '<span style="cursor:pointer" onclick="window.location.href=\\'/__dashboard\\'">🔓 <span style=\\'color:#fff;text-decoration:underline\\'>Switch</span></span>';

    if (slug) {
      h += ' <span style="color:rgba(255,255,255,0.15)">|</span> ';
      h += '<a href="/__proxy__/annnimate/original?component=' + slug + '" target="_blank" style="color:#60f090;text-decoration:none">📦 Original</a> ';
      h += '<a href="/__proxy__/annnimate/original?component=' + slug + '&format=react" target="_blank" style="color:#61dafb;text-decoration:none">⚛ .jsx</a> ';
      h += '<a href="/__proxy__/annnimate/original?component=' + slug + '&format=vue" target="_blank" style="color:#42b883;text-decoration:none">◆ .vue</a>';
    }

    if (kit && KITS[kit]) {
      h += ' <span style="color:rgba(255,255,255,0.15)">|</span> ';
      h += '<span style="color:#aaa">Kit ' + kit + ':</span> ';
      KITS[kit].forEach(function(c) {
        h += '<a href="/__proxy__/annnimate/kit?kit=' + kit + '&component=' + c + '&format=raw" target="_blank" style="color:#f0a060;text-decoration:none;margin:0 2px" title="' + c + '">' + c.replace(/-./g, function(m){return m[1].toUpperCase()}) + '</a> ';
      });
    }

    el.innerHTML = h;
    document.body.appendChild(el);
  }

  // ─── Unlock library component pages ───
  function tryUnlockLibrary() {
    var m = window.location.pathname.match(/^\\/animations\\/([\\w-]+)/);
    if (!m) return;
    var slug = m[1];
    var lockBox = document.querySelector('.flex.h-80.items-center.justify-center');

    fetch('/__proxy__/annnimate/original?component=' + slug)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var viewerData = {
          _slug: slug,
          html: data.html || '',
          css: data.css || '',
          js: data.js || '',
          _react: data.react || '',
          _vue: data.vue || '',
          deps: data.dependencies || [],
          _controls: data.controls || [],
          _selectors: data.selectors || [],
          _tips: data.tips || [],
        };
        window._anmData_lib = viewerData;
        window._anmOriginalData = data;

        // Inject code viewer — replace lock box if paid, or append after preview if free
        if (lockBox) {
          document.querySelectorAll('.flex.h-80.items-center.justify-center').forEach(function(lockInner) {
            var box = lockInner.closest('.flex.flex-col.overflow-hidden.border');
            if (!box) return;
            box.className = box.className.replace('overflow-hidden', '');
            box.style.height = 'auto';
            box.style.maxHeight = 'none';
            box.style.overflow = 'visible';
            box.innerHTML = buildCodeViewer('lib', viewerData);
          });
        } else {
          // Free component: insert code viewer after the iframe/preview section
          var previewSection = document.querySelector('iframe')?.closest('div')?.parentElement;
          if (previewSection) {
            var codeDiv = document.createElement('div');
            codeDiv.style.cssText = 'margin-top:16px;border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden;';
            codeDiv.innerHTML = buildCodeViewer('lib', viewerData);
            previewSection.parentElement.insertBefore(codeDiv, previewSection.nextSibling);
          }
        }

        // Sync annnimate's native customize panel → auto-update "Full" tab in code viewer.
        // The native panel changes data-anm-* attrs on the sandbox iframe via postMessage.
        // We observe those attribute changes on the component root inside the iframe,
        // then rebuild the Full HTML with the new values.
        function syncCustomize() {
          var aside = document.querySelector('aside');
          if (!aside) return;

          // Build a map: normalized aria-label → { attribute, defaultValue }
          var controlMap = {};
          (data.controls || []).forEach(function(c) {
            // "thumb-size" → "thumb size", "duration" → "duration"
            var normalized = c.name.replace(/-/g, ' ').toLowerCase();
            controlMap[normalized] = { attr: c.attribute, def: String(c.value) };
          });

          aside.addEventListener('input', rebuildFull);
          aside.addEventListener('change', rebuildFull);
          // Also catch clicks (for dropdowns/buttons that don't fire input)
          aside.addEventListener('click', function() { setTimeout(rebuildFull, 300); });

          function rebuildFull() {
            setTimeout(function() {
              var d = window._anmOriginalData;
              if (!d) return;
              var customHtml = d.html;
              var changed = {};

              // Read values from native controls using aria-label
              aside.querySelectorAll('input[type="range"], select').forEach(function(ctrl) {
                var ariaLabel = (ctrl.getAttribute('aria-label') || '').toLowerCase();
                var mapping = controlMap[ariaLabel];
                if (!mapping) return;
                var newVal = ctrl.value;
                var re = new RegExp(mapping.attr + '="[^"]*"');
                var match = customHtml.match(re);
                if (match) {
                  customHtml = customHtml.replace(match[0], mapping.attr + '="' + newVal + '"');
                  if (newVal !== mapping.def) changed[mapping.attr] = true;
                }
              });

              // Also handle button-based controls (Side, Ease) — read displayed text
              aside.querySelectorAll('button[aria-label]').forEach(function(btn) {
                var ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
                var mapping = controlMap[ariaLabel];
                if (!mapping) return;
                // The button shows the current value as text in a child span
                var valSpan = btn.querySelector('span:first-child, div:first-child');
                var newVal = valSpan ? valSpan.textContent.trim().toLowerCase() : '';
                if (!newVal) return;
                var re = new RegExp(mapping.attr + '="[^"]*"');
                var match = customHtml.match(re);
                if (match) {
                  customHtml = customHtml.replace(match[0], mapping.attr + '="' + newVal + '"');
                  if (newVal !== mapping.def) changed[mapping.attr] = true;
                }
              });

              var store = window._anmData_lib;
              if (store) {
                store._customHtml = customHtml;
                store._changed = changed;
                store.html = customHtml;
                store._full = '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n<meta charset="UTF-8">\\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\\n<style>\\n' + d.css + '\\n</style>\\n</head>\\n<body>\\n' + customHtml + '\\n<script>\\n' + d.js + '\\n<\\/script>\\n</body>\\n</html>';
                var code = document.getElementById('lib-code');
                var activeTab = document.querySelector('.lib-tab[style*="rgba(96,208,240"]');
                if (code && activeTab) {
                  var tab = activeTab.textContent.includes('Full') ? 'full' : activeTab.textContent.includes('HTML') ? 'html' : null;
                  if (tab) code.innerHTML = highlightAttrs(esc(tab === 'full' ? store._full : store.html), changed);
                }
              }
            }, 300);
          }
        }
        setTimeout(syncCustomize, 1000);

        // Remove lock overlays
        document.querySelectorAll('.absolute.inset-0.flex.flex-col').forEach(function(el) { if (el.textContent.indexOf('Members customize') !== -1) el.remove(); });
        document.querySelectorAll('section.border-t').forEach(function(el) { if (el.textContent.indexOf('full code are part of access') !== -1) el.remove(); });
        document.querySelectorAll('p, div, span').forEach(function(el) {
          if ((el.textContent || '').indexOf('is locked') !== -1 && el.textContent.length < 200) {
            var p = el.closest('.flex.flex-col.items-center.gap-10') || el.closest('[class*="border-t"][class*="pt-20"]');
            if (p) p.remove(); else el.remove();
          }
        });
        document.querySelectorAll('a[href*="/checkout"]').forEach(function(el) {
          if (el.textContent.indexOf('Unlock') !== -1) { var c = el.closest('.flex.flex-col') || el.parentElement; if (c && c.children.length <= 3) c.remove(); }
        });
        document.querySelectorAll('input[disabled], select[disabled], button[disabled]').forEach(function(el) { el.disabled = false; el.style.opacity = '1'; el.style.pointerEvents = 'auto'; });
      })
      .catch(function(e) { console.error('Proxy unlock failed:', e); });
  }

  // ─── Kit code viewer: inject per-component code panels ───
  function tryUnlockKit() {
    var m = window.location.pathname.match(/^\\/kits\\/([\\w-]+)$/);
    if (!m) return;
    var kit = m[1];
    var comps = KITS[kit];
    if (!comps || !comps.length) return;

    // Find a good insertion point — after the main content, before footer
    var footer = document.querySelector('footer') || document.querySelector('[class*="contentinfo"]');
    if (!footer) return;

    // Build container
    var container = document.createElement('section');
    container.id = 'kit-code-section';
    container.style.cssText = 'max-width:1200px;margin:40px auto;padding:0 24px;';
    container.innerHTML = '<h2 style="color:#e8e8f0;font-size:24px;font-weight:700;margin-bottom:24px;font-family:Inter,sans-serif">🔓 Kit Source Code</h2><p style="color:#888;font-size:14px;margin-bottom:32px;font-family:Inter,sans-serif">Select a component to load its source. Click the tabs to switch between HTML, CSS, and JS.</p><div id="kit-comp-buttons" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px"></div><div id="kit-code-viewer" style="border:1px solid rgba(255,255,255,0.1);border-radius:12px;overflow:hidden;display:none"></div>';
    footer.parentNode.insertBefore(container, footer);

    // Add component buttons
    var btnBox = document.getElementById('kit-comp-buttons');
    comps.forEach(function(c) {
      var btn = document.createElement('button');
      btn.textContent = c;
      btn.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#ccc;cursor:pointer;font-size:12px;font-family:SF Mono,monospace;transition:all 0.2s;';
      btn.onmouseenter = function() { btn.style.borderColor = 'rgba(96,208,240,0.4)'; btn.style.color = '#60d0f0'; };
      btn.onmouseleave = function() { if (!btn.classList.contains('active')) { btn.style.borderColor = 'rgba(255,255,255,0.1)'; btn.style.color = '#ccc'; } };
      btn.onclick = function() {
        // Mark active
        btnBox.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); b.style.borderColor = 'rgba(255,255,255,0.1)'; b.style.color = '#ccc'; });
        btn.classList.add('active');
        btn.style.borderColor = 'rgba(96,208,240,0.5)';
        btn.style.color = '#60d0f0';
        btn.style.background = 'rgba(96,208,240,0.1)';

        var viewer = document.getElementById('kit-code-viewer');
        viewer.style.display = 'block';
        viewer.innerHTML = '<div style="padding:20px;color:#888;font-family:monospace">Loading ' + c + '...</div>';

        fetch('/__proxy__/annnimate/kit?kit=' + kit + '&component=' + c)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            window['_anmData_kit_' + c.replace(/-/g,'_')] = data;
            var id = 'kit_' + c.replace(/-/g,'_');
            viewer.style.height = 'auto';
            viewer.style.maxHeight = '600px';
            viewer.style.overflow = 'auto';
            viewer.innerHTML = buildCodeViewer(id, data);
            window['_anmData_' + id] = data;
          })
          .catch(function(e) {
            viewer.innerHTML = '<div style="padding:20px;color:#f06060;font-family:monospace">Error: ' + e.message + '</div>';
          });
      };
      btnBox.appendChild(btn);
    });
  }

  // ─── Init ───
  function init() {
    initBanner();
    setTimeout(tryUnlockLibrary, 1500);
    setTimeout(tryUnlockKit, 2000);
    setTimeout(function() {
      document.querySelectorAll('dialog, [role="dialog"]').forEach(function(d) {
        if (d.textContent.indexOf('Starter Pack') !== -1 || d.textContent.indexOf('free pack') !== -1) d.remove();
      });
    }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 800); });
  else setTimeout(init, 800);
})();
</script>`;

  html = html.replace('</head>', fetchInterceptor + '</head>');
  html = html.replace('</body>', proxyScript + '</body>');
  return html;
}

// ─── EXTERNAL / ASSET PROXY LOGIC ───────────────────────────────────────────
async function proxyExternal(req, res, domain, extPath, targetOrigin) {
  const targetUrl = 'https://' + domain + extPath;
  const startTime = Date.now();
  try {
    const fetchOptions = {
      method: req.method,
      headers: getForwardHeaders(req.headers, targetOrigin),
      redirect: 'follow',
      timeout: 15000,
    };
    
    let reqBodyStr = '';
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      fetchOptions.body = Buffer.concat(buffers);
      reqBodyStr = fetchOptions.body.toString('utf-8');
    }
    const response = await fetch(targetUrl, fetchOptions);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    let buffer = await response.buffer();
    const duration = Date.now() - startTime;

    let resBodyStr = '';
    if (contentType.includes('json') || contentType.includes('text') || contentType.includes('javascript') || contentType.includes('html')) {
      resBodyStr = buffer.toString('utf-8');

      // For annnimate.com HTML responses: rewrite all relative URLs so browser
      // fetches assets through this proxy instead of hitting localhost directly.
      if ((domain === 'annnimate.com' || domain === 'annnimate.b-cdn.net') && contentType.includes('html')) {
        const proxyBase = '/__ext__/' + domain;
        resBodyStr = resBodyStr
          // src="/_next/..." -> src="/__ext__/annnimate.com/_next/..."
          .replace(/src="\/((?!\/))/g, 'src="' + proxyBase + '/')
          // href="/_next/..." -> href="/__ext__/annnimate.com/_next/..."
          .replace(/href="\/((?!\/))/g, 'href="' + proxyBase + '/')
          // action="/..."
          .replace(/action="\/((?!\/))/g, 'action="' + proxyBase + '/')
          // Next.js inline JSON: "/_next/ -> "/__ext__/annnimate.com/_next/
          .replace(/"\/_next\//g, '"' + proxyBase + '/_next/')
          // Next.js inline JSON: "https://annnimate.com/ -> "/__ext__/annnimate.com/
          .replace(/https:\/\/annnimate\.com\//g, proxyBase + '/')
          // Next.js route prefetch: "\/api\/ -> proxy
          .replace(/"\/(api|animations|_next)\//g, '"' + proxyBase + '/$1/');
        buffer = Buffer.from(resBodyStr, 'utf-8');
      }
    } else {
      resBodyStr = `[Binary Data: ${buffer.length} bytes]`;
    }

    addLog(req.method, `/__ext__/${domain}${extPath}`, response.status, duration, {
      reqHeaders: req.headers,
      resHeaders: Object.fromEntries(response.headers.entries()),
      reqBody: reqBodyStr,
      resBody: resBodyStr.slice(0, 2000)
    });

    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': response.headers.get('cache-control') || 'no-cache',
    });
    res.end(buffer);
  } catch (err) {
    const duration = Date.now() - startTime;
    addLog(req.method, `/__ext__/${domain}${extPath}`, 502, duration, {
      reqHeaders: req.headers,
      resHeaders: {},
      reqBody: '',
      resBody: err.message
    });
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('External proxy error: ' + err.message);
    }
  }
}

async function proxyAsset(res, targetUrl, targetOrigin) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': targetOrigin + '/',
        'Accept': '*/*',
      },
      redirect: 'follow',
      timeout: 8000,
    });
    const buffer = await response.buffer();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(response.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(buffer);
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Asset proxy error: ' + err.message);
    }
  }
}

function listCacheEntries(cacheDir) {
  if (!fs.existsSync(cacheDir)) return [];
  const files = fs.readdirSync(cacheDir).filter(f => f.endsWith('.meta.json'));
  return files.map(f => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8'));
      meta.isValid = (Date.now() - meta.timestamp) < CACHE_TTL;
      meta.expiresIn = Math.max(0, CACHE_TTL - (Date.now() - meta.timestamp));
      return meta;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── MASTER DASHBOARD UI ────────────────────────────────────────────────────
function serveDashboard(req, res) {
  // Read Cookie Context
  let targetSite = null;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(^|;)\s*proxy_target\s*=\s*([^;]+)/);
    if (match) targetSite = match[2];
  }

  const isOsmo = targetSite === 'osmo';
  const isModen = targetSite === 'moden';
  const isAnnnimate = targetSite === 'annnimate';
  const siteName = isOsmo ? 'Osmo' : (isModen ? 'Moden' : (isAnnnimate ? 'Annnimate' : ''));
  const activeClass = isOsmo ? 'osmo' : (isModen ? 'moden' : (isAnnnimate ? 'annnimate' : ''));
  const cacheTTLHours = Math.round(CACHE_TTL / 3600000);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Master Proxy — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg-primary: #07070a;
      --bg-secondary: #0f0f15;
      --bg-card: #14141f99;
      --border: rgba(255,255,255,0.06);
      --text-primary: #e8e8f0;
      --text-secondary: #8888a0;
      --text-muted: #555570;
      --accent: ${isOsmo ? '#6cf060' : isAnnnimate ? '#60d0f0' : '#f060a0'};
      --accent-glow: ${isOsmo ? 'rgba(108, 240, 96, 0.15)' : isAnnnimate ? 'rgba(96, 208, 240, 0.15)' : 'rgba(240, 96, 160, 0.15)'};
      --accent-alt: #40d8f0;
      --danger: #f06060;
      --radius: 12px;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 30px 24px;
      overflow-x: hidden;
    }

    .container {
      width: 100%;
      max-width: 1400px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--border);
    }

    .logo-group h1 {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--accent) 0%, var(--accent-alt) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .logo-group p {
      font-size: 13px;
      color: var(--text-secondary);
    }

    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .btn-primary {
      background: var(--accent);
      color: #07070a;
    }

    .btn-primary:hover {
      box-shadow: 0 4px 12px var(--accent-glow);
      transform: translateY(-1px);
    }

    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    .btn-outline:hover {
      border-color: var(--text-secondary);
      color: var(--text-primary);
    }

    /* ─── SITE SELECTOR ─── */
    .site-selector {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 70vh;
      width: 100%;
    }

    .site-selector h2 {
      font-size: 32px;
      margin-bottom: 8px;
      font-weight: 700;
    }

    .site-selector p {
      color: var(--text-secondary);
      margin-bottom: 32px;
    }

    .cards {
      display: flex;
      gap: 24px;
    }

    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 36px 44px;
      text-align: center;
      text-decoration: none;
      transition: all 0.2s;
      width: 220px;
    }

    .card:hover {
      transform: translateY(-4px);
    }

    .card.osmo {
      border-color: rgba(108,240,96,0.25);
      box-shadow: 0 8px 32px rgba(108,240,96,0.06);
    }
    .card.osmo h3 { color: #6cf060; font-size: 24px; margin-bottom: 6px; }

    .card.moden {
      border-color: rgba(240,96,160,0.25);
      box-shadow: 0 8px 32px rgba(240,96,160,0.06);
    }
    .card.moden h3 { color: #f060a0; font-size: 24px; margin-bottom: 6px; }

    .card.annnimate {
      border-color: rgba(96,208,240,0.25);
      box-shadow: 0 8px 32px rgba(96,208,240,0.06);
    }
    .card.annnimate h3 { color: #60d0f0; font-size: 24px; margin-bottom: 6px; }

    .card span {
      color: var(--text-muted);
      font-size: 13px;
    }

    /* ─── LAYOUT ─── */
    .dashboard-layout {
      display: flex;
      gap: 20px;
      width: 100%;
      height: calc(100vh - 140px);
    }

    .left-panel {
      flex: 1.1;
      display: flex;
      flex-direction: column;
      gap: 20px;
      height: 100%;
      min-width: 0;
    }

    .right-panel {
      flex: 0.9;
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      height: 100%;
      min-width: 0;
      position: relative;
    }

    .panel-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.01);
    }

    .panel-header h3 {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
    }

    /* ─── INPUT GROUP & BROWSER ─── */
    .browser-bar {
      display: flex;
      gap: 10px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      padding: 12px 16px;
      border-radius: var(--radius);
      align-items: center;
    }

    .browser-bar .prefix {
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      white-space: nowrap;
    }

    .browser-bar input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-primary);
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      outline: none;
    }

    /* ─── CACHE SECTION ─── */
    .cache-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .cache-info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .cache-stats {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .cache-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 100px;
      overflow-y: auto;
      border-top: 1px solid rgba(255,255,255,0.02);
      padding-top: 8px;
    }

    .cache-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: rgba(255,255,255,0.01);
      border: 1px solid var(--border);
      padding: 8px 12px;
      border-radius: 8px;
    }

    .cache-item-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .cache-path {
      color: var(--accent-alt);
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .cache-path:hover { color: var(--accent); }

    .cache-meta {
      font-size: 10px;
      color: var(--text-muted);
    }

    .cache-item-actions {
      display: flex;
      gap: 4px;
    }

    .btn-icon {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 6px;
      font-size: 12px;
      border-radius: 4px;
      transition: background 0.2s;
    }

    .btn-icon:hover {
      background: rgba(255,255,255,0.05);
      color: var(--text-primary);
    }

    /* ─── DOMAINS MANAGER ─── */
    .domain-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .domain-split {
      display: flex;
      gap: 16px;
    }

    .domain-column {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .domain-column h4 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
    }

    .domain-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 100px;
      overflow-y: auto;
      background: rgba(0,0,0,0.1);
      padding: 6px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.02);
    }

    .domain-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 8px;
      background: rgba(255,255,255,0.01);
      border-radius: 4px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      overflow: hidden;
    }

    .domain-item span {
      text-overflow: ellipsis;
      overflow: hidden;
      white-space: nowrap;
    }

    .domain-item.reported {
      border: 1px dashed rgba(240, 96, 160, 0.2);
    }

    /* ─── REQUEST LOGS ─── */
    .log-box {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    .log-list {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .log-row {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(255,255,255,0.01);
      border: 1px solid transparent;
      cursor: pointer;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      transition: all 0.2s;
      gap: 12px;
    }

    .log-row:hover {
      background: rgba(255,255,255,0.03);
      border-color: rgba(255,255,255,0.05);
    }

    .log-row.active {
      background: var(--accent-glow);
      border-color: var(--accent);
    }

    .log-row .time { color: var(--text-muted); width: 70px; flex-shrink: 0; }
    .log-row .method { color: var(--accent); font-weight: 600; width: 50px; flex-shrink: 0; }
    .log-row .path { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-row .status { font-weight: 600; width: 40px; text-align: right; flex-shrink: 0; }
    .log-row .status.ok { color: var(--accent); }
    .log-row .status.err { color: var(--danger); }
    .log-row .duration { color: var(--text-muted); width: 55px; text-align: right; flex-shrink: 0; }

    .log-cache-tag {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .log-cache-hit { background: rgba(108,240,96,0.12); color: #6cf060; }
    .log-cache-miss { background: rgba(64,216,240,0.12); color: #40d8f0; }

    /* ─── INSPECT PANEL ─── */
    .inspect-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      padding: 20px;
    }

    .inspect-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-align: center;
      gap: 12px;
    }

    .inspect-empty svg {
      width: 48px;
      height: 48px;
      stroke: var(--text-muted);
      fill: none;
    }

    .inspect-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
    }

    .inspect-meta .method {
      background: var(--accent-glow);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: 6px;
      font-weight: 700;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
    }

    .inspect-meta .path {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      color: var(--text-primary);
      word-break: break-all;
    }

    .inspect-tabs {
      display: flex;
      gap: 4px;
      background: rgba(255,255,255,0.02);
      padding: 3px;
      border-radius: 8px;
      margin-bottom: 16px;
    }

    .tab-btn {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
    }

    .tab-btn:hover {
      color: var(--text-primary);
    }

    .tab-btn.active {
      background: rgba(255,255,255,0.06);
      color: var(--text-primary);
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }

    .viewer-area {
      flex: 1;
      background: rgba(0, 0, 0, 0.2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
      overflow: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
      color: #9cdcfe;
    }

    .viewer-area::-webkit-scrollbar { width: 6px; height: 6px; }
    .viewer-area::-webkit-scrollbar-track { background: transparent; }
    .viewer-area::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 3px; }

    /* Custom scrollbars */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.05); border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-group">
        <h1>🔓 Master Proxy Dashboard</h1>
        <p>Advanced Protocol Reverse Engineering & Gateway Panel</p>
      </div>
      <div>
        ${targetSite ? `<a href="/__dashboard?switch=clear" class="btn btn-outline">🔄 Switch Site</a>` : ''}
      </div>
    </header>

    ${!targetSite ? `
      <!-- Site Switcher Selector -->
      <div class="site-selector">
        <h2>Select target site</h2>
        <p>Unlocks client-side subscription protections locally</p>
        <div class="cards">
          <a href="/?switch=osmo" class="card osmo">
            <h3>Osmo</h3>
            <span>osmo.supply</span>
          </a>
          <a href="/?switch=moden" class="card moden">
            <h3>Moden</h3>
            <span>moden.club</span>
          </a>
          <a href="/?switch=annnimate" class="card annnimate">
            <h3>Annnimate</h3>
            <span>annnimate.com</span>
          </a>
        </div>
      </div>
    ` : `
      <!-- Log Panel & Inspect Panel Layout -->
      <div class="dashboard-layout">
        <!-- Left Panel: Browser Address bar, Cache List, CORS manager, Request logs -->
        <div class="left-panel">
          <div class="browser-bar">
            <span class="prefix">http://localhost:4000/</span>
            <input type="text" id="pathInput" placeholder="${isOsmo ? 'vault' : isAnnnimate ? 'animations' : 'library'}" autofocus>
            <button class="btn btn-primary" onclick="goToPath()">Browse →</button>
          </div>

          <div class="cache-box">
            <div class="cache-info-row">
              <h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted);">📦 Cache (${cacheTTLHours}h TTL - ${siteName})</h3>
              <div class="cache-stats" id="cacheStats">Loading...</div>
            </div>
            <div class="cache-list" id="cacheGrid">
              <div style="color: var(--text-muted); font-size:12px; text-align:center; padding:10px;">Loading cache entries...</div>
            </div>
            <div>
              <button class="btn btn-outline" style="padding: 6px 12px; font-size:11px;" onclick="clearAllCache()">🗑️ Clear Cache</button>
            </div>
          </div>

          <!-- CORS Proxy Manager -->
          <div class="domain-box">
            <h3 style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-muted);">🌐 CORS Proxy Manager (Proxied Domains)</h3>
            <div class="domain-split">
              <!-- Active proxied list -->
              <div class="domain-column">
                <h4>Active Proxy List</h4>
                <div class="domain-list" id="proxiedDomainsGrid">
                  <div style="color: var(--text-muted); font-size:11px; text-align:center; padding:10px;">None</div>
                </div>
              </div>
              <!-- Reported/discovered list -->
              <div class="domain-column">
                <h4>Discovered (CORS Warning)</h4>
                <div class="domain-list" id="reportedDomainsGrid">
                  <div style="color: var(--text-muted); font-size:11px; text-align:center; padding:10px;">No warnings</div>
                </div>
              </div>
            </div>
            <div style="display: flex; gap: 8px; margin-top: 4px;">
              <input type="text" id="newDomainInput" placeholder="add-domain.com" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-family: 'JetBrains Mono', monospace; font-size:11px; color: var(--text-primary); flex: 1; outline:none;">
              <button class="btn" style="padding: 6px 12px; font-size:11px; background: var(--accent); color:#000;" onclick="addUserDomain()">Add Domain</button>
            </div>
          </div>

          <div class="log-box">
            <div class="panel-header">
              <h3>📡 Intercepted Traffic Log</h3>
            </div>
            <div class="log-list" id="logContainer">
              <div style="color: var(--text-muted); font-size:12px; text-align:center; padding:20px;">No requests recorded yet. Browse some pages.</div>
            </div>
          </div>
        </div>

        <!-- Right Panel: Click-to-Inspect API/Response Viewer -->
        <div class="right-panel">
          <div class="panel-header">
            <h3>🔍 Request Inspector</h3>
          </div>
          <div class="inspect-content" id="inspectContent">
            <div class="inspect-empty">
              <svg viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-.778.099-1.533.284-2.253" />
              </svg>
              <span>Select a request from the list to inspect raw headers and payloads</span>
            </div>
          </div>
        </div>
      </div>
    `}
  </div>

  <script>
    var currentLogs = [];
    var selectedLogId = null;
    var currentTab = 'resBody';

    function goToPath() {
      var path = document.getElementById('pathInput').value.trim();
      if (path) {
        window.open('/' + path.replace(/^\\/+/, ''), '_blank');
      }
    }

    if (document.getElementById('pathInput')) {
      document.getElementById('pathInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') goToPath();
      });
    }

    // ─── Logs Management ───
    async function fetchLogs() {
      try {
        var res = await fetch('/__proxy__/logs');
        var logs = await res.json();
        currentLogs = logs;
        renderLogs();
      } catch(e) {}
    }

    function renderLogs() {
      var container = document.getElementById('logContainer');
      if (!container) return;

      if (currentLogs.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); font-size:12px; text-align:center; padding:20px;">No requests recorded yet. Browse some pages.</div>';
        return;
      }

      container.innerHTML = currentLogs.slice().reverse().map(function(l) {
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

        var isActive = l.id === selectedLogId ? 'active' : '';

        return '<div class="log-row ' + isActive + '" onclick="selectLog(\\'' + l.id + '\\')">'
          + '<span class="time">' + l.time + '</span>'
          + '<span class="method">' + l.method + '</span>'
          + '<span class="path" title="' + pathStr + '">' + pathStr + '</span>'
          + cacheTag
          + '<span class="status ' + statusClass + '">' + l.status + '</span>'
          + '<span class="duration">' + l.duration + 'ms</span>'
          + '</div>';
      }).join('');
    }

    function selectLog(id) {
      selectedLogId = id;
      renderLogs();
      renderInspector();
    }

    function renderInspector() {
      var panel = document.getElementById('inspectContent');
      if (!panel) return;

      var log = currentLogs.find(function(l) { return l.id === selectedLogId; });
      if (!log) return;

      var reqHeadersStr = formatJSONOrText(log.details.reqHeaders);
      var resHeadersStr = formatJSONOrText(log.details.resHeaders);
      var reqBodyStr = formatBodyContent(log.details.reqBody);
      var resBodyStr = formatBodyContent(log.details.resBody);

      var tabContent = '';
      if (currentTab === 'reqHeaders') tabContent = reqHeadersStr;
      if (currentTab === 'resHeaders') tabContent = resHeadersStr;
      if (currentTab === 'reqBody') tabContent = reqBodyStr;
      if (currentTab === 'resBody') tabContent = resBodyStr;

      panel.innerHTML = 
        '<div class="inspect-meta">'
        + '<span class="method">' + log.method + '</span>'
        + '<span class="path">' + log.path + '</span>'
        + '</div>'
        + '<div class="inspect-tabs">'
        + '<button class="tab-btn ' + (currentTab === 'reqHeaders' ? 'active' : '') + '" onclick="switchTab(\\'' + log.id + '\\', \\'reqHeaders\\')">Req Headers</button>'
        + '<button class="tab-btn ' + (currentTab === 'resHeaders' ? 'active' : '') + '" onclick="switchTab(\\'' + log.id + '\\', \\'resHeaders\\')">Res Headers</button>'
        + '<button class="tab-btn ' + (currentTab === 'reqBody' ? 'active' : '') + '" onclick="switchTab(\\'' + log.id + '\\', \\'reqBody\\')">Req Body</button>'
        + '<button class="tab-btn ' + (currentTab === 'resBody' ? 'active' : '') + '" onclick="switchTab(\\'' + log.id + '\\', \\'resBody\\')">Res Body</button>'
        + '</div>'
        + '<pre class="viewer-area"><code id="inspectViewer"></code></pre>';
        
      document.getElementById('inspectViewer').textContent = tabContent;
    }

    function switchTab(logId, tab) {
      currentTab = tab;
      renderInspector();
    }

    function formatJSONOrText(obj) {
      if (!obj) return '';
      try {
        return JSON.stringify(obj, null, 2);
      } catch(e) {
        return String(obj);
      }
    }

    function formatBodyContent(body) {
      if (!body) return '[Empty Body]';
      if (typeof body === 'object') return JSON.stringify(body, null, 2);
      
      try {
        // Try parsing JSON for pretty print
        var json = JSON.parse(body);
        return JSON.stringify(json, null, 2);
      } catch(e) {
        return body;
      }
    }

    // ─── Cache Management ───
    async function fetchCacheStatus() {
      var grid = document.getElementById('cacheGrid');
      var stats = document.getElementById('cacheStats');
      if (!grid || !stats) return;

      try {
        var res = await fetch('/__proxy__/cache');
        var items = await res.json();
        
        if (items.length === 0) {
          grid.innerHTML = '<div style="color: var(--text-muted); font-size:12px; text-align:center; padding:10px;">No cached pages yet.</div>';
          stats.textContent = '';
          return;
        }

        var totalSize = items.reduce(function(s, i) { return s + (i.size || 0); }, 0);
        stats.textContent = items.length + ' pages (' + formatBytes(totalSize) + ')';

        grid.innerHTML = items.map(function(item) {
          var expiresMin = Math.round(item.expiresIn / 60000);
          var expiresStr = expiresMin > 60 
            ? Math.round(expiresMin / 60) + 'h ' + (expiresMin % 60) + 'm'
            : expiresMin + 'm';
          var cachedTime = new Date(item.cachedAt).toLocaleTimeString('en-US', { hour12: false });
          return '<div class="cache-item">'
            + '<div class="cache-item-info">'
            + '<a href="' + item.path + '" target="_blank" class="cache-path">' + item.path + '</a>'
            + '<span class="cache-meta">Cached ' + cachedTime + ' · Exp ' + expiresStr + '</span>'
            + '</div>'
            + '<div class="cache-item-actions">'
            + '<button class="btn-icon" onclick="clearCachePage(\\'' + item.path + '\\')" title="Clear">✕</button>'
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

    // ─── Domains Management ───
    async function fetchDomains() {
      var proxiedGrid = document.getElementById('proxiedDomainsGrid');
      var reportedGrid = document.getElementById('reportedDomainsGrid');
      if (!proxiedGrid || !reportedGrid) return;

      try {
        var res = await fetch('/__proxy__/domains');
        var data = await res.json();

        // Render Proxied Domains
        if (data.proxied.length === 0) {
          proxiedGrid.innerHTML = '<div style="color: var(--text-muted); font-size:11px; text-align:center; padding:10px;">None</div>';
        } else {
          proxiedGrid.innerHTML = data.proxied.map(function(d) {
            return '<div class="domain-item">'
              + '<span title="' + d + '">' + d + '</span>'
              + '<button class="btn-icon" onclick="removeDomain(\\'' + d + '\\')" title="Remove">✕</button>'
              + '</div>';
          }).join('');
        }

        // Render Reported Domains
        if (data.reported.length === 0) {
          reportedGrid.innerHTML = '<div style="color: var(--text-muted); font-size:11px; text-align:center; padding:10px;">No warnings</div>';
        } else {
          reportedGrid.innerHTML = data.reported.map(function(d) {
            return '<div class="domain-item reported">'
              + '<span style="color: var(--danger);" title="' + d + '">' + d + '</span>'
              + '<button class="btn-icon" onclick="addDomain(\\'' + d + '\\')" title="Proxy this domain" style="color: var(--accent);">＋</button>'
              + '</div>';
          }).join('');
        }
      } catch(e) {}
    }

    async function addDomain(d) {
      await fetch('/__proxy__/domains/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: d })
      });
      fetchDomains();
    }

    async function removeDomain(d) {
      await fetch('/__proxy__/domains/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: d })
      });
      fetchDomains();
    }

    function addUserDomain() {
      var input = document.getElementById('newDomainInput');
      var val = input.value.trim().toLowerCase();
      if (val) {
        addDomain(val);
        input.value = '';
      }
    }

    // Polling setup
    if (document.getElementById('logContainer')) {
      setInterval(fetchLogs, 2000);
      fetchLogs();
      setInterval(fetchCacheStatus, 3000);
      fetchCacheStatus();
      setInterval(fetchDomains, 3000);
      fetchDomains();
    }
  </script>
</body>
</html>`;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

// ─── MAIN HTTP SERVER ───────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
  const urlParts = req.url.split('?');
  const pathname = urlParts[0];
  const query = new URLSearchParams(urlParts[1] || '');

  // 0. Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // 1. Handle Master Dashboard / Switching
  if (pathname === '/__dashboard') {
    if (query.has('switch') && query.get('switch') === 'clear') {
      res.writeHead(302, {
        'Set-Cookie': 'proxy_target=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        'Location': '/__dashboard'
      });
      return res.end();
    }
    return serveDashboard(req, res);
  }

  if (pathname === '/' && query.has('switch')) {
    const target = query.get('switch');
    if (target === 'osmo') {
      res.writeHead(302, {
        'Set-Cookie': 'proxy_target=osmo; Path=/; Max-Age=31536000',
        'Location': '/vault'
      });
      return res.end();
    }
    if (target === 'moden') {
      res.writeHead(302, {
        'Set-Cookie': 'proxy_target=moden; Path=/; Max-Age=31536000',
        'Location': '/library'
      });
      return res.end();
    }
    if (target === 'annnimate') {
      res.writeHead(302, {
        'Set-Cookie': 'proxy_target=annnimate; Path=/; Max-Age=31536000',
        'Location': '/animations'
      });
      return res.end();
    }
  }

  // 2. Handle External Proxied Domains FIRST (before cookie check so __ext__ always works)
  if (pathname.startsWith('/__ext__/')) {
    const extParts = pathname.replace('/__ext__/', '').split('/');
    const extDomain = extParts[0];
    const extPath = '/' + extParts.slice(1).join('/') + (urlParts[1] ? '?' + urlParts[1] : '');
    // Determine target origin based on the domain being requested
    let extTargetOrigin;
    if (extDomain === 'annnimate.com' || extDomain === 'annnimate.b-cdn.net') {
      extTargetOrigin = TARGET_ANNNIMATE;
    } else if (PROXIED_DOMAINS_MODEN.includes(extDomain)) {
      extTargetOrigin = TARGET_MODEN;
    } else {
      extTargetOrigin = TARGET_OSMO;
    }
    return proxyExternal(req, res, extDomain, extPath, extTargetOrigin);
  }

  // 3. Read Cookie Context
  let targetSite = null;
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(^|;)\s*proxy_target\s*=\s*([^;]+)/);
    if (match) targetSite = match[2];
  }

  if (!targetSite) {
    if (pathname === '/') return serveDashboard(req, res);
    // If no context, default to dashboard
    res.writeHead(302, { 'Location': '/__dashboard' });
    return res.end();
  }

  // 3. Setup Context Variables
  const isOsmo = targetSite === 'osmo';
  const isModen = targetSite === 'moden';
  const isAnnnimate = targetSite === 'annnimate';
  const TARGET_ORIGIN = isOsmo ? TARGET_OSMO : isModen ? TARGET_MODEN : isAnnnimate ? TARGET_ANNNIMATE : TARGET_OSMO;
  const CACHE_DIR = isOsmo ? CACHE_DIR_OSMO : isModen ? CACHE_DIR_MODEN : isAnnnimate ? CACHE_DIR_ANNNIMATE : CACHE_DIR_OSMO;
  const stripFn = isOsmo ? stripProtectionOsmo : isModen ? stripProtectionModen : isAnnnimate ? stripProtectionAnnnimate : stripProtectionOsmo;

  // 4. Handle API Endpoints for Dashboard
  if (pathname === '/__proxy__/logs') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(requestLogs));
  }

  if (pathname === '/__proxy__/cache') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(listCacheEntries(CACHE_DIR)));
  }

  if (pathname === '/__proxy__/cache/clear') {
    const clearPath = query.get('path');
    clearCacheEntry(clearPath || null, CACHE_DIR);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify({ 
      success: true, 
      message: clearPath ? 'Cleared cache for ' + clearPath : 'All cache cleared' 
    }));
  }

  if (pathname === '/__proxy__/domains') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    const proxiedList = isOsmo ? PROXIED_DOMAINS_OSMO : isModen ? PROXIED_DOMAINS_MODEN : isAnnnimate ? PROXIED_DOMAINS_ANNNIMATE : PROXIED_DOMAINS_OSMO;
    const reportedList = Array.from(reportedDomains[targetSite] || []);
    return res.end(JSON.stringify({ proxied: proxiedList, reported: reportedList }));
  }

  if (pathname === '/__proxy__/domains/add') {
    if (req.method === 'POST') {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(buffers).toString('utf-8'));
        const domainToAdd = body.domain;
        if (domainToAdd && typeof domainToAdd === 'string') {
          if (isOsmo) {
            if (!PROXIED_DOMAINS_OSMO.includes(domainToAdd)) PROXIED_DOMAINS_OSMO.push(domainToAdd);
          } else if (isAnnnimate) {
            if (!PROXIED_DOMAINS_ANNNIMATE.includes(domainToAdd)) PROXIED_DOMAINS_ANNNIMATE.push(domainToAdd);
          } else {
            if (!PROXIED_DOMAINS_MODEN.includes(domainToAdd)) PROXIED_DOMAINS_MODEN.push(domainToAdd);
          }
          reportedDomains[targetSite].delete(domainToAdd);
        }
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/__proxy__/domains/remove') {
    if (req.method === 'POST') {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(buffers).toString('utf-8'));
        const domainToRemove = body.domain;
        if (domainToRemove && typeof domainToRemove === 'string') {
          if (isOsmo) {
            PROXIED_DOMAINS_OSMO = PROXIED_DOMAINS_OSMO.filter(d => d !== domainToRemove);
          } else if (isAnnnimate) {
            PROXIED_DOMAINS_ANNNIMATE = PROXIED_DOMAINS_ANNNIMATE.filter(d => d !== domainToRemove);
          } else {
            PROXIED_DOMAINS_MODEN = PROXIED_DOMAINS_MODEN.filter(d => d !== domainToRemove);
          }
        }
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  if (pathname === '/__proxy__/domains/report') {
    if (req.method === 'POST') {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(buffers).toString('utf-8'));
        const domainToReport = body.domain;
        if (domainToReport && typeof domainToReport === 'string') {
          const proxiedList = isOsmo ? PROXIED_DOMAINS_OSMO : isAnnnimate ? PROXIED_DOMAINS_ANNNIMATE : PROXIED_DOMAINS_MODEN;
          if (!proxiedList.includes(domainToReport)) {
            reportedDomains[targetSite].add(domainToReport);
          }
        }
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // 5. Handle External Proxied Domains — handled earlier (before cookie check), skip here


  // 5.23. Annnimate: Original source code via Supabase
  // GET /__proxy__/annnimate/original?component=curtain-slider — all formats
  // GET /__proxy__/annnimate/original?component=curtain-slider&format=react — just react
  // GET /__proxy__/annnimate/original — list all components
  if (isAnnnimate && pathname === '/__proxy__/annnimate/original') {
    const component = query.get('component');
    const format = query.get('format'); // react, vue, js, css, html, or null for all
    const startTime = Date.now();
    try {
      if (!component) {
        // List all components with code availability
        const data = await supabaseQuery('animations',
          'select=slug,title,category,is_free_preview,published_at&is_published=eq.true&order=published_at.desc&limit=200');
        const duration = Date.now() - startTime;
        addLog('GET', pathname, 200, duration, { reqHeaders: req.headers, resHeaders: {}, reqBody: '', resBody: data.length + ' components' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ total: data.length, components: data }, null, 2));
      }

      // Fetch specific component with all code columns
      const data = await supabaseQuery('animations',
        'slug=eq.' + encodeURIComponent(component) + '&select=slug,title,category,description,html_code,css_code,js_code,react_code,vue_code,dependencies,custom_attributes,metadata,attributes,specs,show_controls');
      if (!data.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Component not found: ' + component }));
      }
      const comp = data[0];
      const duration = Date.now() - startTime;

      // Single format
      if (format) {
        const formatMap = {
          react: { code: comp.react_code, ext: 'jsx', ct: 'text/jsx' },
          vue: { code: comp.vue_code, ext: 'vue', ct: 'text/html' },
          js: { code: comp.js_code, ext: 'js', ct: 'application/javascript' },
          css: { code: comp.css_code, ext: 'css', ct: 'text/css' },
          html: { code: comp.html_code, ext: 'html', ct: 'text/html' },
        };
        const f = formatMap[format];
        if (!f) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid format. Use: react, vue, js, css, html' }));
        }
        addLog('GET', pathname + '?component=' + component + '&format=' + format, 200, duration, { reqHeaders: req.headers, resHeaders: {}, reqBody: '', resBody: (f.code?.length || 0) + 'B' });
        res.writeHead(200, {
          'Content-Type': f.ct + '; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Content-Disposition': 'inline; filename="' + component + '.' + f.ext + '"',
        });
        return res.end(f.code || '');
      }

      // All formats
      addLog('GET', pathname + '?component=' + component, 200, duration, {
        reqHeaders: req.headers, resHeaders: {},
        reqBody: '', resBody: `Original: react=${comp.react_code?.length || 0}B vue=${comp.vue_code?.length || 0}B js=${comp.js_code?.length || 0}B`
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({
        slug: comp.slug,
        title: comp.title,
        category: comp.category,
        description: comp.description,
        dependencies: comp.dependencies,
        // Source code
        html: comp.html_code || '',
        css: comp.css_code || '',
        js: comp.js_code || '',
        react: comp.react_code || '',
        vue: comp.vue_code || '',
        // Customize & docs
        controls: comp.attributes?.configurables || [],
        selectors: comp.attributes?.selectors || [],
        tips: comp.metadata?.tips || [],
        features: comp.metadata?.features || [],
        teaching: comp.metadata?.teaching || null,
        useCases: comp.metadata?.use_cases || [],
        variations: comp.metadata?.variations || [],
        specs: comp.specs || {},
      }, null, 2));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }
  // 5.24. Annnimate: Kit source code extraction
  // GET /__proxy__/annnimate/kit?kit=reveal — list all components
  // GET /__proxy__/annnimate/kit?kit=reveal&component=logo-draw-split — extract source
  // GET /__proxy__/annnimate/kit?kit=reveal&component=logo-draw-split&format=raw — self-contained HTML
  if (isAnnnimate && pathname === '/__proxy__/annnimate/kit') {
    const kit = query.get('kit');
    const component = query.get('component');
    if (!kit) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ kits: ['reveal', 'menu'] }));
    }

    // Kit component listing
    const KIT_COMPONENTS = {
      reveal: ['logo-draw-split','counter-columns','mosaic-dissolve','logo-fill-cover','image-cycle-zoom','image-trail-loader','grid-flash-cover','composing-grid','hero-marquee','flow-field','fractal-glass-hero','tile-orb','depth-parallax-hero'],
      menu: ['accordion','preview-index','curtain','tile-grid','split-screen','context-shift','push-down','island','pillar','stacked-drawer']
    };
    if (!component) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ kit, components: KIT_COMPONENTS[kit] || [] }));
    }

    const startTime = Date.now();
    try {
      const sandboxUrl = TARGET_ANNNIMATE + '/api/sandbox/kit/' + encodeURIComponent(kit) + '/' + encodeURIComponent(component);
      const resp = await fetch(sandboxUrl, {
        headers: getForwardHeaders(req.headers, TARGET_ANNNIMATE),
        timeout: 15000,
      });
      if (resp.status !== 200) {
        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Kit sandbox returned ' + resp.status }));
      }
      const html = await resp.text();

      const format = query.get('format');
      if (format === 'raw') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      const source = extractSource(html);
      const duration = Date.now() - startTime;
      addLog('GET', pathname + '?kit=' + kit + '&component=' + component, 200, duration, {
        reqHeaders: req.headers, resHeaders: {},
        reqBody: '', resBody: `Kit extracted: CSS ${source.css.length}B, HTML ${source.html.length}B, JS ${source.js.length}B`
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ kit, component, ...source }, null, 2));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 5.25. Annnimate: Source code extraction from sandbox iframe
  // GET /__proxy__/annnimate/source?component=photo-stack-gallery
  if (isAnnnimate && pathname === '/__proxy__/annnimate/source') {
    const component = query.get('component');
    if (!component) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing ?component= parameter' }));
    }
    const startTime = Date.now();
    try {
      const sandboxUrl = TARGET_ANNNIMATE + '/api/sandbox/iframe/' + encodeURIComponent(component);
      const resp = await fetch(sandboxUrl, {
        headers: getForwardHeaders(req.headers, TARGET_ANNNIMATE),
        timeout: 15000,
      });
      if (resp.status !== 200) {
        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Sandbox returned ' + resp.status }));
      }
      const html = await resp.text();

      const source = extractSource(html);
      const duration = Date.now() - startTime;
      addLog('GET', pathname + '?component=' + component, 200, duration, {
        reqHeaders: req.headers, resHeaders: {},
        reqBody: '', resBody: `Extracted: CSS ${source.css.length}B, HTML ${source.html.length}B, JS ${source.js.length}B`
      });

      const format = query.get('format');
      if (format === 'raw') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ component, ...source }, null, 2));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  }

  // 5.5. Annnimate: Full Next.js reverse proxy
  // Unlike Webflow sites, Next.js needs ALL requests proxied (RSC, API, assets, etc.)
  if (isAnnnimate) {
    const startTime = Date.now();

    // Check cache BEFORE hitting upstream (avoids unnecessary fetch)
    const isHtmlPageReq = req.method === 'GET' && !req.headers['rsc'] && !path.extname(pathname);
    if (isHtmlPageReq && isCacheValid(pathname, CACHE_DIR)) {
      const cache = readCache(pathname, CACHE_DIR);
      if (cache) {
        const duration = Date.now() - startTime;
        addLog(req.method, pathname + ' [CACHE]', 200, duration, {
          reqHeaders: req.headers,
          resHeaders: { 'Content-Type': 'text/html; charset=utf-8' },
          reqBody: '', resBody: cache.html.slice(0, 1000)
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(cache.html);
      }
    }

    const targetUrl = TARGET_ORIGIN + req.url;
    try {
      const proxyHeaders = getForwardHeaders(req.headers, TARGET_ORIGIN);
      ['rsc', 'next-router-state-tree', 'next-router-prefetch', 'next-router-segment-prefetch', 'next-url'].forEach(h => {
        if (req.headers[h]) proxyHeaders[h] = req.headers[h];
      });

      const fetchOptions = {
        method: req.method,
        headers: proxyHeaders,
        redirect: 'manual',
        timeout: 15000,
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const buffers = [];
        for await (const chunk of req) buffers.push(chunk);
        fetchOptions.body = Buffer.concat(buffers);
      }

      const response = await fetch(targetUrl, fetchOptions);
      const contentType = response.headers.get('content-type') || 'application/octet-stream';

      // Handle redirects
      if (response.status >= 300 && response.status < 400) {
        let location = response.headers.get('location') || '';
        if (location.startsWith('https://annnimate.com')) {
          location = location.replace('https://annnimate.com', '');
        }
        const duration = Date.now() - startTime;
        addLog(req.method, req.url, response.status, duration, {
          reqHeaders: req.headers,
          resHeaders: Object.fromEntries(response.headers.entries()),
          reqBody: '', resBody: 'Redirect → ' + location
        });
        res.writeHead(response.status, { 'Location': location || '/' });
        return res.end();
      }

      let buffer = await response.buffer();

      // Strip protection on HTML page responses (not RSC, not API, not assets)
      const isHtmlPage = contentType.includes('text/html') && !req.headers['rsc'];
      if (isHtmlPage) {
        let html = buffer.toString('utf-8');
        html = stripFn(html);
        if (response.status === 200) writeCache(pathname, html, CACHE_DIR);

        const duration = Date.now() - startTime;
        addLog(req.method, req.url + ' [FRESH]', response.status, duration, {
          reqHeaders: req.headers,
          resHeaders: Object.fromEntries(response.headers.entries()),
          reqBody: '', resBody: html.slice(0, 1000)
        });
        res.writeHead(response.status, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // Non-HTML: forward transparently
      const duration = Date.now() - startTime;
      addLog(req.method, req.url, response.status, duration, {
        reqHeaders: req.headers,
        resHeaders: Object.fromEntries(response.headers.entries()),
        reqBody: '', resBody: contentType.includes('text') || contentType.includes('json') || contentType.includes('javascript') ? buffer.toString('utf-8').slice(0, 1000) : `[Binary ${buffer.length}B]`
      });

      const resHeaders = {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      };
      const cc = response.headers.get('cache-control');
      if (cc) resHeaders['Cache-Control'] = cc;

      res.writeHead(response.status, resHeaders);
      return res.end(buffer);
    } catch (err) {
      const duration = Date.now() - startTime;
      addLog(req.method, req.url, 502, duration, {
        reqHeaders: req.headers, resHeaders: {},
        reqBody: '', resBody: err.message
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end('<h1>Proxy Error</h1><p>' + err.message + '</p>');
      }
      return;
    }
  }

  // 6. Handle Assets
  const ext = path.extname(pathname).toLowerCase();
  if (['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.webp', '.ico', '.json'].includes(ext)) {
    return proxyAsset(res, TARGET_ORIGIN + req.url, TARGET_ORIGIN);
  }

  // 7. Handle HTML Pages (Fetch, Strip, Cache)
  const startTime = Date.now();
  if (isCacheValid(pathname, CACHE_DIR)) {
    const cache = readCache(pathname, CACHE_DIR);
    if (cache) {
      const duration = Date.now() - startTime;
      addLog(req.method, pathname + ' [CACHE]', 200, duration, {
        reqHeaders: req.headers,
        resHeaders: { 'Content-Type': 'text/html; charset=utf-8', 'X-Osmo-Cache': 'HIT' },
        reqBody: '',
        resBody: cache.html
      });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(cache.html);
    }
  }

  try {
    let proxyReqPath = req.url;
    if (isModen) {
      // Bypass Moden's Webflow/Supabase edge router by adding a double slash
      if (pathname.startsWith('/resource/') || pathname.startsWith('/tools/') || pathname.startsWith('/toolkit/')) {
        proxyReqPath = '/' + proxyReqPath;
      }
    }

    const fetchResponse = await fetch(TARGET_ORIGIN + proxyReqPath, {
      headers: getForwardHeaders(req.headers, TARGET_ORIGIN),
      timeout: 8000,
    });

    if (fetchResponse.status >= 300 && fetchResponse.status < 400) {
      const location = fetchResponse.headers.get('location');
      if (location) {
        const redirectedUrl = location.startsWith('http') ? new URL(location).pathname : location;
        const duration = Date.now() - startTime;
        addLog(req.method, proxyReqPath, fetchResponse.status, duration, {
          reqHeaders: req.headers,
          resHeaders: Object.fromEntries(fetchResponse.headers.entries()),
          reqBody: '',
          resBody: `Redirected to ${redirectedUrl}`
        });
        res.writeHead(fetchResponse.status, { 'Location': redirectedUrl });
        return res.end();
      }
    }

    let html = await fetchResponse.text();
    html = stripFn(html);
    const duration = Date.now() - startTime;

    if (fetchResponse.status === 200) {
      writeCache(pathname, html, CACHE_DIR);
    }

    addLog(req.method, proxyReqPath + ' [FRESH]', fetchResponse.status, duration, {
      reqHeaders: req.headers,
      resHeaders: Object.fromEntries(fetchResponse.headers.entries()),
      reqBody: '',
      resBody: html.slice(0, 1000)
    });

    res.writeHead(fetchResponse.status, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    const duration = Date.now() - startTime;
    addLog(req.method, req.url, 500, duration, {
      reqHeaders: req.headers,
      resHeaders: {},
      reqBody: '',
      resBody: err.message
    });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h1>Proxy Error</h1><p>' + err.message + '</p>');
    }
  }
  } catch (outerErr) {
    console.error('  ⚠️ Server error:', outerErr.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error: ' + outerErr.message);
    }
  }
});

server.listen(PORT, () => {
  console.log("\\n=========================================");
  console.log("🚀 MASTER PROXY RUNNING");
  console.log("=========================================");
  console.log("Dashboard: http://localhost:" + PORT + "/");
  console.log("=========================================\\n");
});

// Limit concurrent connections to prevent overload
server.maxConnections = 50;
server.keepAliveTimeout = 10000;
server.headersTimeout = 15000;

// Save cache and prevent crash on errors
function gracefulShutdown() {
  console.log('\\n  💾 Saving Supabase cache...');
  saveSbCache();
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err) => {
  console.error('  ⚠️ Uncaught:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('  ⚠️ Unhandled rejection:', err?.message || err);
});
