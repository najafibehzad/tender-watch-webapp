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
const PORT = parseInt(process.env.PORT || '3725', 10);

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

// ---- Input validation (Persian-only) ----
function isPersianName(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 80) return false;
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

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
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
    });
  }

  // GET /api/config
  if (p === '/api/config' && req.method === 'GET') {
    return sendJson(res, readConfig());
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// Keep the server responsive: don't let one slow client block others
server.keepAliveTimeout = 5000;
server.headersTimeout = 6000;
server.maxRequestsPerSocket = 1000;
server.timeout = 30000;

server.listen(PORT, () => {
  console.log(`🚀 دیده‌بان مناقصات وب اپ روی پورت ${PORT} آماده است`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   اسکن/PDF در پس‌زمینه اجرا می‌شوند — صفحه هر ۱۰ ثانیه به‌روزرسانی می‌شود`);
});

process.on('uncaughtException', err => console.error('Uncaught:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err.message));