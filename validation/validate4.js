#!/usr/bin/env node
'use strict';
// APPLY-LEVEL Alteon validator (v4): everything validate3 does, PLUS a final
// "apply" whose errors are captured, then "revert apply" to restore the
// device. Motivation (ROUTE-1 field report): some defects exist ONLY at
// apply time - cross-object consistency checks like "Gateways 2 and 3 have
// the same IP address" or LIVE-16's SMTP-username rule. Line-level staging
// can never see those; a user found one in a shipped file. This gate closes
// that class.
// Still blocked: save/boot/reset/shutdown. The device is left as found
// (revert apply undoes the applied-but-unsaved changes).
//
// Based on validate3 (v3): prompt-driven.
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
const FORBIDDEN = /^(save|boot|reset|shutdown)\b/i;   // v4: apply is the point
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
// Settle window after the shell prompt before sending the next line. Default
// 600ms is conservative; long multi-device runs lower it via SETTLE_MS after
// calibrating against a chunk with a known error count.
const SETTLE_MS = parseInt(process.env.SETTLE_MS || '600', 10);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// APPLYWAIT-1 (fleet sweep, 2026-11-10): on large configs the device applies
// for minutes; the 1.5 s idle fallback moved on while "Applying
// Configuration...." was still running, so the apply RESULT was never read
// (11 big files reported APPLY-ERRORS=0 without any result) and "revert
// apply" went unanswered - one run left its config APPLIED on the lab and
// polluted the next file. apply / revert apply now wait for their terminal
// text; no result within LONG_CMD_MS is itself an apply finding.
const LONG_CMD = {
  'apply': /Apply complete|Apply not done|No apply needed/i,
  'revert apply': /Unsaved changes reverted|No unsaved changes to revert|not done/i,
};
const HARNESS_CMDS = new Set(['revert', 'apply', 'revert apply', '/', 'exit']);
const LONG_CMD_MS =parseInt(process.env.LONG_CMD_MS || String(30 * 60 * 1000), 10);
const conn = new Client();
let buf = '', transcript = '', idle = null, stream = null, current = null, started = false;
let cmdBuf = '';            // everything received since the current command was sent
// leading revert (+ its confirm) clears any pending changes left by earlier
// sessions. Tail: "/" returns to the Main menu so the final "exit" LOGS OUT --
// an "exit" in a submenu only pops one level, leaving a live CLI session that
// counts against the device's concurrent-session limit until idle timeout
// (enough leaked sessions and the device resets new SSH connects).
// v4 tail: apply (errors captured), then "revert apply" restores the device
// to its pre-run applied state; final "/"+exit logs out cleanly.
const queue = ['revert', ...lines, 'apply', 'revert apply', '/', 'exit'];
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
  cmdBuf = '';
  stream.write(current + '\n');
  armIdle();
}
const longWait = () => (current !== null ? LONG_CMD[current.trim()] : null);
function armIdle() {
  clearTimeout(idle);
  if (longWait()) {
    idle = setTimeout(() => {
      findings.push({ line: 'APPLY', error: 'NO RESULT within ' + Math.round(LONG_CMD_MS / 60000) + ' min for "' + current.trim() + '" (treat as failed; device state unknown)' });
      transcript += '\n[APPLYWAIT-1 timeout on "' + current.trim() + '"]\n';
      onResponse(cmdBuf, true);
    }, LONG_CMD_MS);
    return;
  }
  idle = setTimeout(() => { onResponse(buf); }, 1500); // fallback if no prompt seen
}
function onResponse(resp, longDone) {
  clearTimeout(idle);
  if (longWait()) resp = cmdBuf;      // whole apply output, across pager/confirm resets
  // echo verification: characters occasionally get eaten if a line lands
  // while the device is printing — a mangled echo means the device executed
  // something OTHER than the config line. On mismatch the session may also be
  // running one response BEHIND (seen on 10k-line configs), so RESYNC first:
  // wait for the stream to go fully quiet, discard it, then resend once.
  if (current !== null && current.trim().length > 2 && !longDone && !longWait() && !stripAnsi(resp).includes(current.trim()) && !retried) {
    retried = true;
    clearTimeout(idle);
    idle = setTimeout(() => { buf = ''; send(true); }, 1500);
    return;
  }
  if (current !== null && ERROR_RE.test(resp)) {
    if (current.trim() === 'apply') {
      // v4: the apply response can carry SEVERAL consistency errors - keep
      // every one as its own finding (these are the errors staging cannot see)
      for (const em of resp.match(/Error\s*:?[^\r\n]*/gi) || []) {
        findings.push({ line: 'APPLY', error: em.trim().slice(0, 200) });
      }
    } else {
      const m = resp.match(/(Error\s*:?[^\r\n]*|[^\r\n]*bad port[^\r\n]*|[^\r\n]*bad value[^\r\n]*|[^\r\n]*unknown command[^\r\n]*|[^\r\n]*cannot be set[^\r\n]*|[^\r\n]*out of range[^\r\n]*)/i);
      findings.push({ line: current, error: (m ? m[0] : resp).trim().slice(0, 200) });
    }
  } else if (current !== null && !current.trim().startsWith('/') && current.trim().split(/\s+/).length >= 2 &&
             /^Usage:/m.test(stripAnsi(resp))) {
    // USAGE-1: a line WITH arguments answered by "Usage: ..." was refused -
    // the device prints no "Error". 74 such lines in the fleet went unflagged
    // (HC dest, filter/VLAN/group names, segment addvlan).
    const u = stripAnsi(resp).match(/^Usage:[^\r\n]*/m);
    findings.push({ line: current, error: 'REFUSED ' + u[0].trim().slice(0, 190) });
  }
  send();
}
function onData(d) {
  const s = d.toString('utf8'); buf += s; cmdBuf += s; transcript += s;
  if (!started) return;               // login banner handled by the start timer
  const clean = stripAnsi(buf);
  if (PAGER_RE.test(clean)) {         // long output pager -> next page, same response continues
    buf = '';
    stream.write(' ');
    armIdle();
    return;
  }
  if (CONFIRM_RE.test(clean)) {       // interactive confirm -> answer y, same command continues
    // PROMPT-1: a CONFIG line that asks y/n is a paste trap - an engineer
    // pasting the file feeds the NEXT lines in as answers (probed 34.5.7:
    // "add 1" on an untagged port asked "Confirm changing PVID", swallowed
    // the next VLAN's lines, and the port was not added). The harness still
    // answers y so the run continues, but the line is a finding.
    if (current !== null && !HARNESS_CMDS.has(current.trim()) && !/Confirm seeing above note/.test(clean)) {
      const q = clean.trim().split(/\r?\n/).filter((l) => /\[y/.test(l)).pop() || clean.trim().slice(-120);
      if (!findings.length || findings[findings.length - 1].line !== current) findings.push({ line: current, error: 'PROMPT (paste trap) ' + q.trim().slice(0, 180) });
    }
    transcript += '\n>>> y (auto-confirm)\n';
    buf = '';
    stream.write('y\n');
    armIdle();
    return;
  }
  if (longWait() && !longWait().test(stripAnsi(cmdBuf))) { armIdle(); return; }   // APPLYWAIT-1: still applying
  if (PROMPT_RE.test(stripAnsi(buf.slice(-160)))) {
    // Prompt seen, but the device may still be printing a menu banner. Sending
    // the next line now races that output and gets characters eaten, which
    // silently mangles a "/c/..." path line: the CLI then stays at the previous
    // menu and the FOLLOWING attribute line reports "unknown command" — a
    // phantom defect blamed on the converter. Wait for the stream to settle.
    // Tunable: the echo-verification + resend in onResponse() is the real
    // safety net, so a shorter settle is viable for long runs. Calibrate any
    // new value against a chunk with a known error count before trusting it.
    clearTimeout(idle);
    idle = setTimeout(() => { const r = buf; buf = ''; onResponse(r); }, SETTLE_MS);
    return;
  }
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
  const applyErrors = findings.filter(f => f.line === 'APPLY');
  const report = {
    host, when: new Date().toISOString(), totalLines: lines.length,
    linesSent: sent, linesUnsent: queue.length,
    errorCount: findings.length, applyErrorCount: applyErrors.length, findings
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  fs.writeFileSync(reportFile.replace('.json', '.transcript.txt'), transcript);
  console.log('DONE host=' + host + ' lines=' + report.totalLines + ' sent=' + sent +
    (queue.length ? ' UNSENT=' + queue.length : '') + ' realErrors=' + report.errorCount +
    ' APPLY-ERRORS=' + applyErrors.length);
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
const budgetMs = Math.max(180000, lines.length * 1200 + 60000) + 2 * LONG_CMD_MS;
setTimeout(() => { console.error('GLOBAL TIMEOUT'); try { conn.end(); } catch (e) {} finish(); }, budgetMs);
