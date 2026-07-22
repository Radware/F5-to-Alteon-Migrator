#!/usr/bin/env node
'use strict';
// Non-destructive Alteon syntax validation harness.
// Streams a generated Alteon CLI config into a live Alteon over SSH,
// captures the device's response to every line, then REVERTs all pending
// changes and exits. It never sends "apply" or "save".
//
// Usage: node validate.js <host> <user> <pass> <configfile> <reportfile>
const fs = require('fs');
const { Client } = require('ssh2');

const [host, user, pass, cfgFile, reportFile] = process.argv.slice(2);
const lines = fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/);

const FORBIDDEN = /^(apply|save|boot|reset|shutdown)\b/i;
const conn = new Client();
let buf = '';
let transcript = '';
let idle = null;
let stream = null;
let queue = [...lines.filter(l => l.trim().length), 'diff', 'revert', 'y', 'exit'];
let current = null;
const findings = [];

function send() {
  if (!queue.length) return;
  current = queue.shift();
  if (FORBIDDEN.test(current.trim())) {
    findings.push({ line: current, response: 'SKIPPED BY HARNESS (forbidden persistent command)' });
    return send();
  }
  transcript += '\n>>> ' + current + '\n';
  stream.write(current + '\n');
}

function onData(d) {
  const s = d.toString('utf8');
  buf += s; transcript += s;
  clearTimeout(idle);
  idle = setTimeout(() => {
    const resp = buf; buf = '';
    if (current !== null && /error|failed|unknown|bad|invalid|not allowed|denied|cannot/i.test(resp)) {
      findings.push({ line: current, response: resp.trim().slice(0, 400) });
    }
    if (queue.length) send();
    else { try { conn.end(); } catch (e) {} finish(); }
  }, 700);
}

let done = false;
function finish() {
  if (done) return; done = true;
  const report = {
    host, when: new Date().toISOString(),
    totalLines: lines.filter(l => l.trim().length).length,
    errorCount: findings.length,
    findings
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportFile.replace('.json', '.transcript.txt'), transcript);
  console.log('VALIDATION DONE host=' + host + ' lines=' + report.totalLines + ' errors=' + report.errorCount);
  process.exit(0);
}

conn.on('ready', () => {
  conn.shell({ term: 'vt100', rows: 1000, cols: 200 }, (err, s) => {
    if (err) { console.error('shell error: ' + err.message); process.exit(2); }
    stream = s;
    s.on('data', onData);
    s.on('close', finish);
    setTimeout(() => { buf = ''; send(); }, 2500);
  });
});
conn.on('error', e => { console.error('SSH error: ' + e.message); process.exit(2); });
conn.on('keyboard-interactive', (n, i, il, prompts, cb) => cb([pass]));
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 20000 });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); try { conn.end(); } catch (e) {} finish(); }, 180000);
