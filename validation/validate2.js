#!/usr/bin/env node
'use strict';
// Non-destructive Alteon validator (v2): tighter error detection.
// Only Alteon's explicit "Error" / "Error:" responses count as failures;
// menu help text (printed when entering a submenu) is not an error.
// Streams config -> diff -> revert -> exit. Never apply/save/boot/reset.
const fs = require('fs');
const { Client } = require('ssh2');
const [host, user, pass, cfgFile, reportFile] = process.argv.slice(2);
const lines = fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/);
const FORBIDDEN = /^(apply|save|boot|reset|shutdown)\b/i;
const ERROR_RE = /Error\s*:|bad port|bad value|unknown command|not allowed|invalid input|cannot be set|does not exist|out of range/i;

const conn = new Client();
let buf = '', transcript = '', idle = null, stream = null, current = null;
let queue = [...lines.filter(l => l.trim().length), 'diff', 'revert', 'y', 'exit'];
const findings = [];

function send() {
  if (!queue.length) return;
  current = queue.shift();
  if (FORBIDDEN.test(current.trim())) { findings.push({ line: current, error: 'SKIPPED (forbidden persistent command)' }); return send(); }
  transcript += '\n>>> ' + current + '\n';
  stream.write(current + '\n');
}
function onData(d) {
  const s = d.toString('utf8'); buf += s; transcript += s;
  clearTimeout(idle);
  idle = setTimeout(() => {
    const resp = buf; buf = '';
    if (current !== null && ERROR_RE.test(resp)) {
      const m = resp.match(/(Error\s*:?[^\r\n]*|[^\r\n]*bad port[^\r\n]*|[^\r\n]*unknown command[^\r\n]*|[^\r\n]*cannot be set[^\r\n]*)/i);
      findings.push({ line: current, error: (m ? m[0] : resp).trim().slice(0, 200) });
    }
    if (queue.length) send(); else { try { conn.end(); } catch (e) {} finish(); }
  }, 700);
}
let done = false;
function finish() {
  if (done) return; done = true;
  const report = { host, when: new Date().toISOString(), totalLines: lines.filter(l => l.trim().length).length, errorCount: findings.length, findings };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportFile.replace('.json', '.transcript.txt'), transcript);
  console.log('DONE host=' + host + ' lines=' + report.totalLines + ' realErrors=' + report.errorCount);
  process.exit(0);
}
conn.on('ready', () => conn.shell({ term: 'vt100', rows: 2000, cols: 200 }, (err, s) => {
  if (err) { console.error(err.message); process.exit(2); }
  stream = s; s.on('data', onData); s.on('close', finish);
  setTimeout(() => { buf = ''; send(); }, 2500);
}));
conn.on('error', e => { console.error('SSH error: ' + e.message); process.exit(2); });
conn.on('keyboard-interactive', (n, i, il, p, cb) => cb([pass]));
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 20000 });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); try { conn.end(); } catch (e) {} finish(); }, 180000);
