#!/usr/bin/env node
'use strict';
// Non-destructive Alteon validator (v3): prompt-driven.
//
// Improvements over validate2.js (which mis-validated when the device had
// pending config changes from an earlier session):
//  - Answers interactive prompts: the login "Confirm seeing above note [y]:"
//    (shown when pending changes exist) and "Please enter y to perform the
//    action:" — validate2 never answered these, so every subsequent line was
//    swallowed by the prompt and nothing was actually validated.
//  - Starts with a `revert` so validation always begins from a clean slate
//    (pending changes are unapplied by definition; discarding them is safe).
//  - Paces on the CLI prompt ("...# ") instead of a fixed 700 ms idle timer:
//    faster on long configs and immune to latency spikes. Idle timer kept as
//    a fallback for responses without a prompt.
//  - Global timeout scales with config size.
//
// Still hard-gated non-destructive: never sends apply/save/boot/reset/shutdown.
const fs = require('fs');
const { Client } = require('ssh2');
const [host, user, pass, cfgFile, reportFile] = process.argv.slice(2);
if (!reportFile) { console.error('usage: node validate3.js <host> <user> <pass> <config> <report.json>'); process.exit(2); }
const lines = fs.readFileSync(cfgFile, 'utf8').split(/\r?\n/).filter(l => l.trim().length);
const FORBIDDEN = /^(apply|save|boot|reset|shutdown)\b/i;
const ERROR_RE = /Error\s*:|bad port|bad value|unknown command|not allowed|invalid input|cannot be set|does not exist|out of range/i;
// interactive prompts the device may show; answered with "y" out-of-band
const CONFIRM_RE = /(Confirm seeing above note \[y\]:|Please enter y to perform the action:|Confirm [^\n]*\[y\/n\]:?)\s*$/;
// pager shown for long output (e.g. `diff`); answered with a space
const PAGER_RE = /Press q to quit, any other key to continue\s*$/;
// value prompt (e.g. `maxcon 1000` asking for a mode) -- means the config line
// is NOT paste-safe; recorded as a finding and answered with Enter (default)
const VALUE_PROMPT_RE = /\[[^\]\n]*\]\s*:\s*$/;  // colon required: menu banners end with "...Menu]" but prompts end with "]:"
// Alteon CLI prompt, e.g. ">> Main#" / ">> Real Server nc_srv1#" (trailing space optional)
const PROMPT_RE = /^>> [^\n]*#\s*$/m;
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const conn = new Client();
let buf = '', transcript = '', idle = null, stream = null, current = null, started = false;
// leading revert (+ its confirm) clears any pending changes left by earlier
// sessions. Tail: "/" returns to the Main menu so the final "exit" LOGS OUT --
// an "exit" in a submenu only pops one level, leaving a live CLI session that
// counts against the device's concurrent-session limit until idle timeout
// (enough leaked sessions and the device resets new SSH connects).
const queue = ['revert', ...lines, 'diff', 'revert', '/', 'exit'];
const findings = [];
let sent = 0;

let retried = false;
function send(resending) {
  clearTimeout(idle);
  if (!resending) {
    if (!queue.length) { try { conn.end(); } catch (e) {} return finish(); }
    current = queue.shift();
    retried = false;
    if (FORBIDDEN.test(current.trim())) { findings.push({ line: current, error: 'SKIPPED (forbidden persistent command)' }); return send(); }
    sent++;
    if (sent % 200 === 0) console.log('  ...' + sent + '/' + (lines.length + 3) + ' lines');
  }
  transcript += '\n>>> ' + current + (resending ? ' (RESEND)' : '') + '\n';
  buf = '';
  stream.write(current + '\n');
  armIdle();
}
function armIdle() {
  clearTimeout(idle);
  idle = setTimeout(() => { onResponse(buf); }, 1500); // fallback if no prompt seen
}
function onResponse(resp) {
  clearTimeout(idle);
  // echo verification: characters occasionally get eaten if a line lands
  // while the device is printing — a mangled echo means the device executed
  // something OTHER than the config line. On mismatch the session may also be
  // running one response BEHIND (seen on 10k-line configs), so RESYNC first:
  // wait for the stream to go fully quiet, discard it, then resend once.
  if (current !== null && current.trim().length > 2 && !stripAnsi(resp).includes(current.trim()) && !retried) {
    retried = true;
    clearTimeout(idle);
    idle = setTimeout(() => { buf = ''; send(true); }, 1500);
    return;
  }
  if (current !== null && ERROR_RE.test(resp)) {
    const m = resp.match(/(Error\s*:?[^\r\n]*|[^\r\n]*bad port[^\r\n]*|[^\r\n]*bad value[^\r\n]*|[^\r\n]*unknown command[^\r\n]*|[^\r\n]*cannot be set[^\r\n]*|[^\r\n]*out of range[^\r\n]*)/i);
    findings.push({ line: current, error: (m ? m[0] : resp).trim().slice(0, 200) });
  }
  send();
}
function onData(d) {
  const s = d.toString('utf8'); buf += s; transcript += s;
  if (!started) return;               // login banner handled by the start timer
  const clean = stripAnsi(buf);
  if (PAGER_RE.test(clean)) {         // long output pager -> next page, same response continues
    buf = '';
    stream.write(' ');
    armIdle();
    return;
  }
  if (CONFIRM_RE.test(clean)) {       // interactive confirm -> answer y, same command continues
    transcript += '\n>>> y (auto-confirm)\n';
    buf = '';
    stream.write('y\n');
    armIdle();
    return;
  }
  if (PROMPT_RE.test(stripAnsi(buf.slice(-160)))) { const r = buf; buf = ''; onResponse(r); return; }
  if (VALUE_PROMPT_RE.test(clean) && current !== null && !/^(diff|revert|exit|y)$/.test(current.trim())) {
    // a config line asked for more input -> not paste-safe -> converter bug
    findings.push({ line: current, error: 'INTERACTIVE PROMPT (line is not paste-safe): ' + clean.slice(-120).trim().slice(-100) });
    transcript += '\n>>> <Enter> (auto-default)\n';
    buf = '';
    stream.write('\n');
    armIdle();
    return;
  }
  armIdle();
}
let done = false;
function finish() {
  if (done) return; done = true;
  const report = {
    host, when: new Date().toISOString(), totalLines: lines.length,
    linesSent: sent, linesUnsent: queue.length,
    errorCount: findings.length, findings
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportFile.replace('.json', '.transcript.txt'), transcript);
  console.log('DONE host=' + host + ' lines=' + report.totalLines + ' sent=' + sent +
    (queue.length ? ' UNSENT=' + queue.length : '') + ' realErrors=' + report.errorCount);
  process.exit(findings.length || queue.length ? 1 : 0);
}
conn.on('ready', () => conn.shell({ term: 'vt100', rows: 2000, cols: 200 }, (err, s) => {
  if (err) { console.error(err.message); process.exit(2); }
  stream = s; s.on('data', onData); s.on('close', finish);
  setTimeout(() => {
    started = true;
    // answer a pending login note if one is on screen, then start
    if (CONFIRM_RE.test(buf)) { transcript += '\n>>> y (login note confirm)\n'; stream.write('y\n'); }
    buf = '';
    setTimeout(send, 1000);
  }, 3000);
}));
conn.on('error', e => {
  if (done) return;
  // Alteon terminates the socket with an RST (not a clean close) on logout,
  // so a "read ECONNRESET" after the last command is the NORMAL end of a run.
  // Persist whatever we have; linesUnsent in the report shows whether the
  // session died early or finished.
  if (!queue.length) { finish(); return; }
  transcript += '\n[SSH error mid-run: ' + e.message + ']\n';
  console.error('SSH session ended early: ' + e.message + ' (' + queue.length + ' lines unsent)');
  finish();
});
conn.on('keyboard-interactive', (n, i, il, p, cb) => cb([pass]));
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 20000 });
const budgetMs = Math.max(180000, lines.length * 1200 + 60000);
setTimeout(() => { console.error('GLOBAL TIMEOUT'); try { conn.end(); } catch (e) {} finish(); }, budgetMs);
