#!/usr/bin/env node
'use strict';
// Minimal password-auth SSH exec helper (Windows ssh.exe cannot take a
// password non-interactively). Runs one command, prints its output.
//   node ssh-run.js <host> <user> <pass> <command>
// Or upload a file first:
//   node ssh-run.js <host> <user> <pass> --put <local> <remote>
const fs = require('fs');
const { Client } = require('ssh2');
const [host, user, pass, ...rest] = process.argv.slice(2);
if (!rest.length) { console.error('usage: node ssh-run.js <host> <user> <pass> (<command> | --put <local> <remote>)'); process.exit(2); }
const conn = new Client();
conn.on('ready', () => {
  if (rest[0] === '--put') {
    conn.sftp((e, sftp) => {
      if (e) { console.error(e.message); process.exit(2); }
      sftp.fastPut(rest[1], rest[2], (err) => {
        if (err) { console.error(err.message); process.exit(2); }
        console.log('uploaded ' + rest[2]);
        conn.end(); process.exit(0);
      });
    });
    return;
  }
  conn.exec(rest.join(' '), { pty: true }, (e, stream) => {
    if (e) { console.error(e.message); process.exit(2); }
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', (code) => { conn.end(); process.exit(code || 0); });
  });
});
conn.on('keyboard-interactive', (n, i, il, p, cb) => cb([pass]));
conn.on('error', (e) => { console.error('SSH: ' + e.message); process.exit(2); });
conn.connect({ host, username: user, password: pass, tryKeyboard: true, readyTimeout: 20000 });
setTimeout(() => { console.error('TIMEOUT'); process.exit(3); }, 120000);
