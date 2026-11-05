'use strict';
// HTTP service: POST an F5 config or archive to /convert, get the output files
// back as a zip. Stateless: the upload is spooled to the temp dir (an emptyDir
// in Kubernetes) and removed as soon as the response is ready.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { zip } = require('./zip');

const MB = 1024 * 1024;
const RD_MODES = ['auto', 'segment', 'split'];
// only the config entries of an archive are held in memory; this caps them
const MAX_CONFIG_BYTES = 256 * MB;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function saveBody(req, file, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.unpipe(out);
        out.destroy();
        reject(new HttpError(413, 'upload exceeds the ' + Math.floor(maxBytes / MB) + ' MB limit'));
      }
    });
    req.on('close', () => { if (!req.complete) { out.destroy(); reject(new HttpError(400, 'upload aborted')); } });
    out.on('error', reject);
    out.on('finish', () => resolve(size));
    req.pipe(out);
  });
}

function convert(file, rdMode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'convert-worker.js'), {
      workerData: { file, rdMode, maxConfigBytes: MAX_CONFIG_BYTES }
    });
    const timer = setTimeout(() => {
      reject(new HttpError(504, 'conversion timed out'));
      worker.terminate();
    }, timeoutMs);
    worker.on('message', (m) => {
      if (m.files) resolve(m.files);
      else reject(new HttpError(m.status, m.error));
    });
    worker.on('error', reject);        // e.g. out of memory in the worker
    worker.on('exit', () => { clearTimeout(timer); reject(new Error('worker exited early')); });
  });
}

async function handleConvert(req, res, url, cfg) {
  const rdMode = url.searchParams.get('rdMode') || 'auto';
  if (!RD_MODES.includes(rdMode)) throw new HttpError(400, 'rdMode must be auto, segment, or split');
  if (Number(req.headers['content-length']) > cfg.maxUploadBytes) {
    throw new HttpError(413, 'upload exceeds the ' + Math.floor(cfg.maxUploadBytes / MB) + ' MB limit');
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'f5-to-alteon-'));
  try {
    const file = path.join(dir, 'upload');
    const size = await saveBody(req, file, cfg.maxUploadBytes);
    if (size === 0) throw new HttpError(400, 'empty upload: send the file as the request body');
    const body = zip(await convert(file, rdMode, cfg.convertTimeoutMs));
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="alteon-migration.zip"',
      'Content-Length': body.length
    });
    res.end(body);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj) + '\n';
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers));
  res.end(body);
}

// Reject without reading the rest of the upload. The connection has to close,
// but closing with unread data can reset it before the client sees the error,
// so give the client a moment to read it first.
function sendErrorAndClose(req, res, status, message, headers) {
  sendJson(res, status, { error: message }, Object.assign({ Connection: 'close' }, headers));
  req.resume();
  res.on('finish', () => setTimeout(() => req.destroy(), 2000).unref());
}

function createServer(opts) {
  const cfg = Object.assign({ maxUploadBytes: 4096 * MB, maxConcurrent: 2, convertTimeoutMs: 300000, uploadTimeoutMs: 1800000 }, opts);
  let active = 0;
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => console.log(req.method + ' ' + req.url + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms'));
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname !== '/convert') return sendErrorAndClose(req, res, 404, 'not found');
    if (req.method !== 'POST') return sendErrorAndClose(req, res, 405, 'use POST', { Allow: 'POST' });
    if (active >= cfg.maxConcurrent) {
      return sendErrorAndClose(req, res, 503, 'busy: too many conversions in progress', { 'Retry-After': '30' });
    }
    active++;
    try {
      await handleConvert(req, res, url, cfg);
    } catch (e) {
      if (!e.status) console.error('conversion failed: ' + e.message);
      sendErrorAndClose(req, res, e.status || 500, e.status ? e.message : 'conversion failed');
    } finally {
      active--;
    }
  });
  // Node's 5 minute default would cut off a multi-GB upload on a slow link
  server.requestTimeout = cfg.uploadTimeoutMs;
  return server;
}

function positiveEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  const n = Number(process.env[name]);
  if (!(n > 0)) { console.error('error: ' + name + ' must be a positive number'); process.exit(1); }
  return n;
}

function serve() {
  const port = positiveEnv('PORT', 8080);
  const server = createServer({
    maxUploadBytes: positiveEnv('MAX_UPLOAD_MB', 4096) * MB,
    maxConcurrent: positiveEnv('MAX_CONCURRENT', 2),
    convertTimeoutMs: positiveEnv('CONVERT_TIMEOUT_SEC', 300) * 1000,
    uploadTimeoutMs: positiveEnv('UPLOAD_TIMEOUT_SEC', 1800) * 1000
  });
  server.listen(port, () => console.log('f5-to-alteon service listening on port ' + port));
  // let in-flight conversions finish when Kubernetes stops the pod
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createServer, serve };
