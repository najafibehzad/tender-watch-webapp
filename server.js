#!/usr/bin/env node
// سرور وب اپ دیده‌بان مناقصات — نسخه ۳ (بازنویسی ۲۰۲۶-۰۹-۱۷)
// اجرا: node server.js  →  http://localhost:3725
//
// چرا سریع‌تر است:
//  - اسکن و PDF در پس‌زمینه می‌روند و بلافاصله پاسخ می‌دهند (اتصال HTTP بسته نمی‌شود)
//  - کش ۶۰ ثانیه‌ای： کلیک متوالی روی «اسکن فوری» فوراً جواب می‌دهد
//  - پولِ ۱۵ ثانیه‌ای فقط اطلاعات جدید را می‌کشد (بازارگاه لیست بازسازی نمی‌شود)
//  - مسیرها و باینر نود از import.meta.url / process.execPath گرفته می‌شوند (بhardcode نیستند)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WATCH = path.resolve(HERE, '..', 'tender-watch');
const PUBLIC = path.resolve(HERE, 'public');
const NODE_BIN = process.execPath;
const WATCH_SCRIPT = path.join(WATCH, 'tender_watch.mjs');
let PORT = parseInt(process.env.PORT || '3725', 10);

const CONFIG_P = path.join(WATCH, 'watch_config.json');
const STATE_P = path.join(WATCH, 'watch_state.json');

// ---- Cache & background job state ----
const CACHE_TTL = 60000; // 60 seconds
let scanCache = { data: null, ts: 0 };
let scanRunning = false;
let lastScanAt = null;
let lastScanError = null;

let pdfRunning = false;
let pdfCache = { data: null, ts: 0 };
let lastPdfAt = null;

// ---- گزارش کامل شهر (فراخوانی city_report.mjs در fardis-tenders) ----
const FARDIS = path.resolve(HERE, '..', 'fardis-tenders');
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
let reportRunning = false;
let reportCache = { data: null, ts: 0 };
let lastReportAt = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---- JSON helpers ----
function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}
function writeJson(p, obj) {
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(t, p);
}
function readConfig() { return readJson(CONFIG_P, null); }
function readState() {
  const st = readJson(STATE_P, null);
  if (st) st.seenCount = Object.keys(st.seen || {}).length;
  return st;
}

// ---- Server-side rendering (page shows content even if JS is blocked) ----
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escJs(s) {
  return String(s == null ? '' : s).replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\\/g, '\\\\');
}
function renderCitiesSR(cities) {
  if (!cities || cities.length === 0) return '<div style="color:var(--text3);font-size:13px;">شهری اضافه نشده</div>';
  return cities.map(c => {
    if (c._reportSelected === undefined) c._reportSelected = true;
    return `<div class="item ${c._disabled ? 'disabled' : ''}">
        <div class="item-left" style="display:flex;align-items:center;gap:12px;">
          <input type="checkbox" ${c._reportSelected ? 'checked' : ''} style="accent-color:var(--accent);" width="18">
          <div>
            <div class="item-name">${escHtml(c.name)}</div>
            <div class="item-detail">${escHtml(c.province || '')} ${c.id ? '· کد: ' + c.id : ''}</div>
          </div>
        </div>
        <div class="toggle ${c._disabled ? '' : 'on'}"></div>
      </div>`;
  }).join('');
}
function renderTopicsSR(topics) {
  if (!topics || Object.keys(topics).length === 0) return '<div style="color:var(--text3);font-size:13px;"> موضوعی اضافه نشده</div>';
  return Object.entries(topics).map(([name, kw]) => {
    const kws = Array.isArray(kw) ? kw.join(', ') : kw;
    const isObj = typeof kw === 'object';
    const disabled = isObj ? kw._disabled : false;
    return `<div class="item ${disabled ? 'disabled' : ''}">
        <div class="item-left" style="display:flex;align-items:center;gap:12px;">
          <input type="checkbox" style="accent-color:var(--accent);" width="18">
          <div>
            <div class="item-name">${escHtml(name)}</div>
            <div class="item-detail">${escHtml(kws)}${disabled ? ' · خاموش' : ''}</div>
          </div>
        </div>
        <div class="toggle ${disabled ? '' : 'on'}"></div>
      </div>`;
  }).join('');
}
function provincesSR(cfg) {
  const ps = [...new Set((cfg.districts || []).map(d => d.province).filter(Boolean))].sort();
  return ps.map(p => `<option value="${escJs(p)}">${escHtml(p)}</option>`).join('');
}

function renderCityOptionsSR(cfg) {
  if (!cfg || !cfg.districts || cfg.districts.length === 0) {
    return '<option value="">شهری برای نمایش وجود ندارد</option>';
  }
  // Group cities by province
  const map = {};
  for (const d of cfg.districts) {
    if (d._disabled) continue;
    const prov = d.province || 'نامشخص';
    if (!map[prov]) map[prov] = [];
    map[prov].push(d);
  }
  const provinces = Object.keys(map).sort();
  let html = '';
  for (const prov of provinces) {
    const cities = map[prov].sort((a, b) => a.name.localeCompare(b.name));
    html += `<optgroup label="${escHtml(prov)}">`;
    for (const c of cities) {
      html += `<option value="${escJs(c.name)}">${escHtml(c.name)}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}
function formatFaDateSR(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fa-IR') + ' ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

// ---- Input validation (Persian-only) ----
// نام باید فقط حروف فارسی/فارسی-عدد داشته باشد و با «-» شروع نشود
// (جلوگیری از اینکه کاربر یه آرگومانِ جدید به جای نام شهر بفرسته)
function isPersianName(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 80) return false;
  if (s.trimStart().startsWith('-')) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (!(c >= 0x0600 && c <= 0x06FF) && !(c >= 0x06F0 && c <= 0x06F9) &&
        c !== 0x20 && c !== 0x200C && c !== 0x2D) return false;
  }
  return true;
}
function isPersianKeywords(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 200) return false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (!(c >= 0x0600 && c <= 0x06FF) && !(c >= 0x06F0 && c <= 0x06F9) &&
        c !== 0x20 && c !== 0x200C && c !== 0x2D && c !== 0x2C) return false;
  }
  return true;
}

// ---- Gzip compression ----
function sendGzipJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  const buf = Buffer.from(json, 'utf8');
  zlib.gzip(buf, (err, compressed) => {
    if (err) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(json);
      return;
    }
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
    });
    res.end(compressed);
  });
}
function sendJson(res, data, status = 200) {
  const json = JSON.stringify(data);
  if (json.length > 500) return sendGzipJson(res, data, status);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

// ---- Run tender_watch in background (never blocks the request handler) ----
function runWatch(args, timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;
    const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };

    import('node:child_process').then(cp => {
      const child = cp.spawn(NODE_BIN, [WATCH_SCRIPT, ...args], {
        cwd: WATCH,
        maxBuffer: 10 * 1024 * 1024,
      });
      let stdout = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, error: 'زمان تمام شد' }); }, timeoutMs);

      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', () => {});
      child.on('close', code => {
        clearTimeout(timer);
        const out = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = out.length - 1; i >= 0; i--) {
          try { return finish(JSON.parse(out[i])); } catch {}
        }
        finish({ ok: code === 0, raw: stdout });
      });
      child.on('error', err => { clearTimeout(timer); finish({ ok: false, error: String(err) }); });
    });
  });
}

// ---- Background scan job ----
async function doScan() {
  const result = await runWatch(['scan', '--json'], 150000);
  scanCache = { data: result, ts: Date.now() };
  lastScanAt = new Date().toISOString();
  lastScanError = result.ok ? null : (result.error || 'اسکن با خرابی مواجه شد');
  return result;
}

// ---- Background PDF job ----
async function doPdf() {
  const result = await runWatch(['pdf', '--json'], 240000);
  pdfCache = { data: result, ts: Date.now() };
  lastPdfAt = new Date().toISOString();
  if (result.ok && result.pdfFile) {
    try {
      const desktopPath = path.join(process.env.USERPROFILE || 'C:\\Users\\behzad\\Desktop', '');
      const fileName = path.basename(result.pdfFile);
      const destPath = path.join(desktopPath, fileName);
      fs.copyFileSync(result.pdfFile, destPath);
      result.pdfFileDesktop = destPath;
      try {
        const cp = await import('node:child_process');
        cp.execFileSync('powershell.exe', ['-Command', `Start-Process "${destPath}"`], { timeout: 5000 });
      } catch {}
    } catch {}
  }
  return result;
}

// ---- Run city_report.mjs (full per-city PDF report with tender links) ----
function runReport(city, province, timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;
    const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };
    import('node:child_process').then(cp => {
      const args = [path.join(FARDIS, 'city_report.mjs'), city];
      if (province) args.push(province);
      args.push('--no-open');
      const child = cp.spawn(NODE_BIN, args, {
        cwd: FARDIS,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CHROME_PATH },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, error: 'زمان تمام شد' }); }, timeoutMs);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => {
        clearTimeout(timer);
        const out = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const errLines = stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
        // city_report.mjs last meaningful line is "PDF: <path>"
        let pdfFile = null;
        for (let i = out.length - 1; i >= 0; i--) {
          const m = out[i].match(/^PDF:\s*(.+)$/);
          if (m) { pdfFile = m[1].trim(); break; }
        }
        if (pdfFile) return finish({ ok: true, pdfFile, raw: stdout });
        for (let i = out.length - 1; i >= 0; i--) {
          try { return finish(JSON.parse(out[i])); } catch {}
        }
        // no PDF and no JSON → failure; extract a concise error line (stdout first, then stderr)
        let err = '';
        for (let i = out.length - 1; i >= 0; i--) {
          if (/^(Error|FAILED|rate-limited|\u0627\u0631\u0631\u0627\u0632)/i.test(out[i])) { err = out[i]; break; }
        }
        if (!err) {
          for (let i = errLines.length - 1; i >= 0; i--) {
            if (/^(Error|FAILED|rate-limited|\u0627\u0631\u0631\u0627\u0632)/i.test(errLines[i])) { err = errLines[i]; break; }
          }
        }
        finish({ ok: false, error: err || 'گزارش تولید نشد', raw: stdout, stderr: stderr.trim() });
      });
      child.on('error', err => { clearTimeout(timer); finish({ ok: false, error: String(err) }); });
    });
  });
}

// ---- Background per-city report job ----
async function doReport(city, province) {
  const result = await runReport(city, province, 300000);
  reportCache = { data: result, ts: Date.now() };
  lastReportAt = new Date().toISOString();
  if (result.ok && result.pdfFile) {
    try {
      const desktopPath = process.env.USERPROFILE || 'C:\\Users\\behzad\\Desktop';
      const fileName = path.basename(result.pdfFile);
      const destPath = path.join(desktopPath, fileName);
      fs.copyFileSync(result.pdfFile, destPath);
      result.pdfFileDesktop = destPath;
    } catch {}
  }
  return result;
}

// ---- Read POST body (size-limited) ----
function readBody(req, limit = 1 << 20) {
  return new Promise(resolve => {
    const chunks = [];
    let len = 0;
    let tooBig = false;
    req.on('data', c => {
      if (tooBig) return;
      len += c.length;
      if (len > limit) { tooBig = true; req.destroy(); return resolve({ __tooBig: true }); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return resolve({ __tooBig: true });
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// ---- HTTP request handler (created fresh per port attempt) ----
async function handleRequest(req, res) {
  // Reject anything that isn't GET/POST quickly
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method not allowed');
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // GET /health — lightweight liveness, no file reads
  if (p === '/health' && req.method === 'GET') {
    return sendJson(res, { ok: true, scanRunning, pdfRunning, port: PORT });
  }

  // GET /api/status — fast, no scan
  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, {
      ok: true,
      config: readConfig(),
      state: readState(),
      scanRunning,
      lastScan: lastScanAt,
      scanCached: !!scanCache.data && (Date.now() - scanCache.ts) < CACHE_TTL,
      lastScanData: scanCache.data,
      lastScanError,
      pdfRunning,
      lastPdf: lastPdfAt,
      lastPdfData: pdfCache.data,
      reportRunning,
      lastReport: lastReportAt,
      lastReportData: reportCache.data,
    });
  }

  // GET /api/config
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, readConfig());
  }

  // GET /api/summary — ساختاریافته: لیست آگهی‌های جدید + شهرستان‌ها + متن خبر
  if (p === '/api/summary' && req.method === 'GET') {
    const cfg = readConfig();
    const st = readState();
    const d = scanCache.data;
    return sendJson(res, {
      ok: true,
      lastScan: lastScanAt,
      lastScanError,
      scanCached: !!scanCache.data && (Date.now() - scanCache.ts) < CACHE_TTL,
      scanRunning,
      newCount: d ? d.newCount : 0,
      byCity: d ? d.byCity : null,
      items: d ? d.items : null,
      failed: d ? d.failed : null,
      message: d ? d.message : null,
      activeCities: (cfg?.districts || []).filter(c => !c._disabled).length,
      seenCount: st?.seenCount || 0,
    });
  }

  // POST /api/scan — returns IMMEDIATELY; scan runs in background, client polls /api/status
  if (p === '/api/scan' && req.method === 'POST') {
    const now = Date.now();
    if (scanRunning) {
      return sendJson(res, { ok: true, scanRunning: true, reply: 'اسکن در حال اجراست... لطفاً کمی صبر کنید' });
    }
    if (scanCache.data && (now - scanCache.ts) < CACHE_TTL) {
      return sendJson(res, { ok: true, cached: true, ...scanCache.data });
    }
    scanRunning = true;
    lastScanError = null;
    doScan().finally(() => { scanRunning = false; });
    return sendJson(res, { ok: true, scanRunning: true, startedAt: new Date().toISOString(), reply: 'اسکن شروع شد' });
  }

  // POST /api/pdf — returns IMMEDIATELY; PDF runs in background
  if (p === '/api/pdf' && req.method === 'POST') {
    if (pdfRunning) {
      return sendJson(res, { ok: true, pdfRunning: true, reply: 'PDF در حال تولید است... لطفاً کمی صبر کنید' });
    }
    if (pdfCache.data && (Date.now() - pdfCache.ts) < CACHE_TTL) {
      return sendJson(res, { ok: true, cached: true, ...pdfCache.data });
    }
    pdfRunning = true;
    doPdf().finally(() => { pdfRunning = false; });
    return sendJson(res, { ok: true, pdfRunning: true, startedAt: new Date().toISOString(), reply: 'در حال تولید PDF...' });
  }

  // POST /api/report — گزارش کامل شهر (city_report.mjs): هر اگهی لینک داره، مهلت‌دارها قرمزن
  if (p === '/api/report' && req.method === 'POST') {
    const { city, province } = await readBody(req);
    if (!isPersianName(city)) return sendJson(res, { ok: false, error: 'نام شهر نامعتبر' }, 400);
    if (reportRunning) {
      return sendJson(res, { ok: true, reportRunning: true, reply: 'گزارش در حال تولید است... لطفاً کمی صبر کنید' });
    }
    if (reportCache.data && reportCache.data.pdfFile && (Date.now() - reportCache.ts) < CACHE_TTL) {
      return sendJson(res, { ok: true, cached: true, ...reportCache.data });
    }
    reportRunning = true;
    doReport(city, province).finally(() => { reportRunning = false; });
    return sendJson(res, { ok: true, reportRunning: true, city, startedAt: new Date().toISOString(), reply: 'در حال تولید گزارش کامل...' });
  }

  // POST /api/toggle
  if (p === '/api/toggle' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!isPersianName(name)) return sendJson(res, { ok: false, error: 'نام نامعتبر' }, 400);
    const cfg = readConfig();
    if (!cfg) return sendJson(res, { ok: false, error: 'config not found' }, 500);
    const ci = cfg.districts?.find(d => d.name === name);
    if (ci) {
      ci._disabled = !ci._disabled;
      writeJson(CONFIG_P, cfg);
      scanCache = { data: null, ts: 0 };
      return sendJson(res, { ok: true, on: !ci._disabled,
        reply: `${name} ${!ci._disabled ? 'روشن' : 'vimosh'} شد` });
    }
    if (cfg.topics && cfg.topics[name] !== undefined) {
      cfg.topics[name]._disabled = !cfg.topics[name]._disabled;
      writeJson(CONFIG_P, cfg);
      scanCache = { data: null, ts: 0 };
      return sendJson(res, { ok: true, on: !cfg.topics[name]._disabled,
        reply: `topic ${name} ${!cfg.topics[name]._disabled ? 'on' : 'off'}` });
    }
    return sendJson(res, { ok: false, error: 'not found' }, 404);
  }

  // POST /api/add-city
  if (p === '/api/add-city' && req.method === 'POST') {
    const { city, province } = await readBody(req);
    if (!isPersianName(city)) return sendJson(res, { ok: false, error: 'نام شهر نامعتبر' }, 400);
    const cfg = readConfig();
    if (!cfg) return sendJson(res, { ok: false, error: 'config not found' }, 500);
    if (cfg.districts?.some(d => d.name === city)) {
      return sendJson(res, { ok: false, error: 'شهر قبلاً وجود دارد' }, 400);
    }
    cfg.districts.push({ name: city, id: '0', province: province || 'نام مشخص نشده' });
    writeJson(CONFIG_P, cfg);
    scanCache = { data: null, ts: 0 };
    return sendJson(res, { ok: true, reply: `${city} اضافه شد` });
  }

  // POST /api/add-topic
  if (p === '/api/add-topic' && req.method === 'POST') {
    const { name, keywords, park } = await readBody(req);
    if (!isPersianName(name)) return sendJson(res, { ok: false, error: 'نام موضوع نامعتبر' }, 400);
    if (!isPersianKeywords(keywords)) return sendJson(res, { ok: false, error: 'کلیدواژه نامعتبر' }, 400);
    const cfg = readConfig();
    if (!cfg) return sendJson(res, { ok: false, error: 'config not found' }, 500);
    if (cfg.topics && cfg.topics[name] !== undefined) {
      return sendJson(res, { ok: false, error: 'topic already exists' }, 400);
    }
    if (!cfg.topics) cfg.topics = {};
    cfg.topics[name] = keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (park) {
      if (!cfg.parkTopics) cfg.parkTopics = [];
      cfg.parkTopics.push(name);
      if (!cfg.parkRegex) cfg.parkRegex = '(پارک|بوستان|فضای سبز|محوطه سبز|گلستان)';
    }
    writeJson(CONFIG_P, cfg);
    scanCache = { data: null, ts: 0 };
    return sendJson(res, { ok: true, reply: `topic ${name} اضافه شد` });
  }

  // Static files
  if (p === '/' || p === '/index.html') {
    const filePath = path.resolve(PUBLIC, 'index.html');
    if (!filePath.startsWith(PUBLIC + path.sep)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      let html = data.toString('utf8');
      // Server-side render core content so the page is useful even if JS is blocked
      const cfg = readConfig();
      const st = readState();
      if (cfg) {
        const activeCities = (cfg.districts || []).filter(c => !c._disabled).length;
        const activeTopics = Object.keys(cfg.topics || {}).filter(t => !cfg.topics[t]._disabled).length;
        html = html.replace(/{{STAT_CITIES}}/g, activeCities);
        html = html.replace(/{{STAT_TOPICS}}/g, activeTopics);
        html = html.replace(/{{STAT_SEEN}}/g, st?.seenCount || 0);
        html = html.replace(/{{STAT_NEW}}/g, lastScanAt ? formatFaDateSR(lastScanAt) : '—');
        html = html.replace(/{{LAST_SCAN}}/g, lastScanAt ? ` آخرین اسکن: <strong>${formatFaDateSR(lastScanAt)}</strong>` : 'در حال بارگذاری...');
        html = html.replace(/{{CITIES_LIST}}/g, renderCitiesSR(cfg.districts));
        html = html.replace(/{{TOPICS_LIST}}/g, renderTopicsSR(cfg.topics));
        html = html.replace(/{{PROVINCES}}/g, provincesSR(cfg));
        html = html.replace(/{{CITY_OPTIONS}}/g, renderCityOptionsSR(cfg));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// Keep the server responsive: don't let one slow client block others
function makeServer() {
  const s = http.createServer(handleRequest);
  s.keepAliveTimeout = 5000;
  s.headersTimeout = 6000;
  s.maxRequestsPerSocket = 1000;
  s.timeout = 30000;
  return s;
}

// پورت‌گاه: اگه پورت پیش‌уй اشغال بود (یه سرور قدیمی از همین اپ باقی مونده)،
// پیام شفاف می‌دهیم و یه سری پورت بعدی رو هم امتحان می‌کنیم تا اپ از اول نیفته.
function startServer(firstPort) {
  let port = firstPort;
  const tryListen = () => {
    const server = makeServer();
    server.once('error', err => {
      if (err.code === 'EADDRINUSE') {
        console.error(`⚠️ پورت ${port} اشغال است — احتمالاً یه نسخهٔ قدیمی از همین اپ روی این پورت اجرا می‌کنه.`);
        console.error(`   برای پاک کردن: PowerShell → Get-NetTCPConnection -LocalPort ${port} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`);
        port++;
        if (port > firstPort + 3) {
          console.error('❌ هیچ پورتی باز نشد');
          process.exit(1);
        }
        tryListen();
      } else {
        console.error('❌ خطای سرور:', err.message);
        process.exit(1);
      }
    });
    server.listen(port, '0.0.0.0', () => {
      PORT = port;
      console.log(`🚀 دیده‌بان مناقصات وب اپ روی پورت ${port} آماده است`);
      console.log(`   http://localhost:${port}`);
      console.log(`   اسکن/PDF در پس‌زمینه اجرا می‌شوند — صفحه هر ۱۰ ثانیه به‌روزرسانی می‌شود`);
    });
  };
  tryListen();
}
startServer(PORT);

process.on('uncaughtException', err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));