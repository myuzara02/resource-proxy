const http = require('http');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

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
    details: details || {
      reqHeaders: {},
      resHeaders: {},
      reqBody: '',
      resBody: ''
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
];

// ─── DOMAIN DISCOVERY & HEADERS FORWARDING ──────────────────────────────────
const reportedDomains = {
  osmo: new Set(),
  moden: new Set()
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
  cleanHeaders['referer'] = targetOrigin + '/';
  cleanHeaders['origin'] = targetOrigin;
  return cleanHeaders;
}

// ─── CACHE SYSTEM ───────────────────────────────────────────────────────────
function ensureCacheDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureCacheDir(CACHE_DIR_OSMO);
ensureCacheDir(CACHE_DIR_MODEN);

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

// ─── EXTERNAL / ASSET PROXY LOGIC ───────────────────────────────────────────
async function proxyExternal(req, res, domain, extPath, targetOrigin) {
  const targetUrl = "https://" + domain + extPath;
  const startTime = Date.now();
  try {
    const fetchOptions = {
      method: req.method,
      headers: getForwardHeaders(req.headers, targetOrigin),
      redirect: 'follow',
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
    const buffer = await response.buffer();
    const duration = Date.now() - startTime;

    let resBodyStr = '';
    if (contentType.includes('json') || contentType.includes('text') || contentType.includes('javascript') || contentType.includes('html')) {
      resBodyStr = buffer.toString('utf-8');
    } else {
      resBodyStr = `[Binary Data: ${buffer.length} bytes]`;
    }

    addLog(req.method, `/__ext__/${domain}${extPath}`, response.status, duration, {
      reqHeaders: req.headers,
      resHeaders: Object.fromEntries(response.headers.entries()),
      reqBody: reqBodyStr,
      resBody: resBodyStr
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
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end("External proxy error: " + err.message);
  }
}

async function proxyAsset(res, targetUrl, targetOrigin) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': targetOrigin + '/',
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
    res.end("Proxy error: " + err.message);
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
  const siteName = isOsmo ? 'Osmo' : (isModen ? 'Moden' : '');
  const activeClass = isOsmo ? 'osmo' : 'moden';
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
      --accent: ${isOsmo ? '#6cf060' : '#f060a0'};
      --accent-glow: ${isOsmo ? 'rgba(108, 240, 96, 0.15)' : 'rgba(240, 96, 160, 0.15)'};
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
        </div>
      </div>
    ` : `
      <!-- Log Panel & Inspect Panel Layout -->
      <div class="dashboard-layout">
        <!-- Left Panel: Browser Address bar, Cache List, CORS manager, Request logs -->
        <div class="left-panel">
          <div class="browser-bar">
            <span class="prefix">http://localhost:4000/</span>
            <input type="text" id="pathInput" placeholder="${isOsmo ? 'vault' : 'library'}" autofocus>
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
  const urlParts = req.url.split('?');
  const pathname = urlParts[0];
  const query = new URLSearchParams(urlParts[1] || '');

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
  }

  // 2. Read Cookie Context
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
  const TARGET_ORIGIN = isOsmo ? TARGET_OSMO : TARGET_MODEN;
  const CACHE_DIR = isOsmo ? CACHE_DIR_OSMO : CACHE_DIR_MODEN;
  const stripFn = isOsmo ? stripProtectionOsmo : stripProtectionModen;

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
    const proxiedList = isOsmo ? PROXIED_DOMAINS_OSMO : PROXIED_DOMAINS_MODEN;
    const reportedList = Array.from(reportedDomains[targetSite]);
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
          const proxiedList = isOsmo ? PROXIED_DOMAINS_OSMO : PROXIED_DOMAINS_MODEN;
          if (!proxiedList.includes(domainToReport)) {
            reportedDomains[targetSite].add(domainToReport);
          }
        }
      } catch (e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true }));
  }

  // 5. Handle External Proxied Domains (e.g. Outseta APIs)
  if (pathname.startsWith('/__ext__/')) {
    const parts = pathname.replace('/__ext__/', '').split('/');
    const domain = parts[0];
    const extPath = '/' + parts.slice(1).join('/') + (urlParts[1] ? '?' + urlParts[1] : '');
    return proxyExternal(req, res, domain, extPath, TARGET_ORIGIN);
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
    if (!isOsmo) {
      // Bypass Moden's Webflow/Supabase edge router by adding a double slash
      if (pathname.startsWith('/resource/') || pathname.startsWith('/tools/') || pathname.startsWith('/toolkit/')) {
        proxyReqPath = '/' + proxyReqPath;
      }
    }

    const fetchResponse = await fetch(TARGET_ORIGIN + proxyReqPath, {
      headers: getForwardHeaders(req.headers, TARGET_ORIGIN),
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
      resBody: html
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
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end("<h1>Proxy Error</h1><p>" + err.message + "</p>");
  }
});

server.listen(PORT, () => {
  console.log("\\n=========================================");
  console.log("🚀 MASTER PROXY RUNNING");
  console.log("=========================================");
  console.log("Dashboard: http://localhost:" + PORT + "/");
  console.log("=========================================\\n");
});
