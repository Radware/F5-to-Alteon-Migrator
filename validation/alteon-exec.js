#!/usr/bin/env node
'use strict';
// Live Alteon command runner for the round-trip lab (NOT the validator).
// Unlike validate3.js this tool MAY send `apply` (behavioral testing needs
// live config), but still hard-blocks `save`/`boot`/`reset`/`shutdown`:
// nothing touches FLASH, so a reboot restores the device's saved state.
//
//   node alteon-exec.js <host> <user> <pass> <commands.txt> [transcript.txt]
//
// commands.txt: one CLI line per line; '#' comments and blanks skipped.
// Prompts are answered automatically (login note, action confirms, pager).
const fs = require('fs');
const { Client } = require('ssh2');
const [host, user, pass, cmdFile, outFile] = process.argv.slice(2);
if (!cmdFile) { console.error('usage: node alteon-exec.js <host> <user> <pass> <commands.txt> [transcript.txt]'); process.exit(2); }
const FORBIDDEN = /^(save|boot|reset|shutdown)\b/i;
// generic: any y/n or action-confirm prompt (incl. the ", n to skip it" re-prompt variant)
const CONFIRM_RE = /(Confirm seeing above note \[y\]:|y to perform the action[^\n]*:|\[y\/n\][^\n]*:)\s*$/;
const PAGER_RE = /Press q to quit, any other key to continue\s*$/;
const PROMPT_RE = /^>> [^\n]*#\s*$/m;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const lines = fs.readFileSync(cmdFile, 'utf8').split(/\r?\n/)
  .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
const queue = [...lines, '/', 'exit'];
const conn = new Client();
let buf = '', transcript = '', idle = null, stream = null, current = null, started = false, done = false;

function finish(code) {
  if (done) return; done = true;
  if (outFile) fs.writeFileSync(outFile, transcript);
  process.exit(code);
}
let retried = false;
function send(resending) {
  clearTimeout(idle);
  if (!resending) {
    if (!queue.length) { try { conn.end(); } catch (e) {} return finish(0); }
    current = queue.shift();
    retried = false;
  }
  if (FORBIDDEN.test(current)) { console.log('SKIPPED (forbidden): ' + current); return send(); }
  transcript += '\n>>> ' + current + (resending ? ' (RESEND)' : '') + '\n';
  console.log('### ' + current + (resending ? '  (resend)' : ''));
  buf = '';
  stream.write(current + '\n');
  armIdle();
}
function armIdle() { clearTimeout(idle); idle = setTimeout(() => onResponse(buf), 4000); }
function onResponse(resp) {
  clearTimeout(idle);
  const clean = stripAnsi(resp).trim();
  // echo verification: the device echoes every accepted line. A mangled echo
  // (characters eaten while a menu banner was printing) means the command
  // did NOT execute as sent -> resend it once.
  if (current !== null && current.length > 2 && !clean.includes(current) && !retried) {
    retried = true;
    console.log('  ! echo mismatch, resending');
    return send(true);
  }
  const out = clean.split('\n').slice(0, 30).join('\n');
  if (out && current !== null) console.log(out.split('\n').filter(l => l.trim() && !l.startsWith('>> ')).slice(0, 12).join('\n'));
  send();
}
function onData(d) {
  const s = d.toString('utf8'); buf += s; transcript += s;
  if (!started) return;
  const clean = stripAnsi(buf);
  if (PAGER_RE.test(clean)) { buf = ''; stream.write(' '); armIdle(); return; }
  if (CONFIRM_RE.test(clean)) { transcript += '\n>>> y (auto)\n'; buf = ''; stream.write('y\n'); armIdle(); return; }
  if (PROMPT_RE.test(stripAnsi(buf.slice(-160)))) {
    // prompt seen: wait a settle window for any trailing output before
    // sending the next line (racing the echo corrupts input)
    clearTimeout(idle);
    idle = setTimeout(() => { const r = buf; buf = ''; onResponse(r); }, 600);
    return;
  }
  armIdle();
}
conn.on('ready', () => conn.shell({ term: 'vt100', rows: 2000, cols: 200 }, (err, s) => {
  if (err) { console.error(err.message); process.exit(2); }
  stream = s; s.on('data', onData); s.on('close', () => finish(0));
  setTimeout(() => {
    started = true;
    if (CONFIRM_RE.test(stripAnsi(buf))) stream.write('y\n');
    buf = '';
    setTimeout(send, 1000);
  }, 3000);
}));
conn.on('error', e => {
  if (done) return;
  if (!queue.length) return finish(0);   // RST on logout is normal
  console.error('SSH ended early: ' + e.message + ' (' + queue.length + ' unsent)');
  finish(1);
});
conn.on('keyboard-interactive', (n, i, il, p, cb) => cb([pass]));
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 25000 });
setTimeout(() => { console.error('GLOBAL TIMEOUT'); finish(3); }, Math.max(180000, lines.length * 1500 + 60000));
