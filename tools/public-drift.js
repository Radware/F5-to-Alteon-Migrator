#!/usr/bin/env node
'use strict';
// Release guard: would the next publish ERASE work that exists only on the
// public repo? publish-public.ps1 replaces the public tree with the private
// one, so a collaborator's change merged on radware/main disappears unless it
// was first brought into the private repo.
//
// How: find the last snapshot this script published (its "Source-Commit:"
// trailer, or - for snapshots made before the trailer existed - a tree
// identical to some private commit). Every path changed on the public side
// since then must be identical in HEAD; otherwise it is listed and the exit
// code is 1.
//
//   node tools/public-drift.js            (run after `git fetch radware`)
const { execFileSync } = require('child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tryGit = (...args) => { try { return git(...args); } catch (e) { return null; } };

const pub = tryGit('rev-parse', '--verify', '--quiet', 'radware/main');
if (!pub) { console.log('public-drift: no radware/main yet - nothing to protect'); process.exit(0); }

const privateTrees = new Set((tryGit('log', '--all', '--format=%T', '--not', 'radware/main') || '').split('\n')
  .concat((tryGit('log', 'HEAD', '--format=%T') || '').split('\n')).filter(Boolean));

let base = null;
for (const c of git('rev-list', '--first-parent', 'radware/main').split('\n')) {
  const src = tryGit('log', '-1', '--format=%(trailers:key=Source-Commit,valueonly)', c);
  if (src && tryGit('cat-file', '-e', src.trim() + '^{commit}') !== null) { base = c; break; }
  if (privateTrees.has(git('rev-parse', c + '^{tree}'))) { base = c; break; }
}
if (!base) {
  console.error('public-drift: cannot find the last published snapshot on radware/main - refusing to guess.');
  process.exit(1);
}
if (base === pub) { console.log('public-drift: clean - the public repo has no changes since the last release'); process.exit(0); }

const fs = require('fs');
const os = require('os');
const path = require('path');
const blob = (rev, p) => tryGit('rev-parse', '--verify', '--quiet', rev + ':' + p);
// Both sides changed the file: is the PUBLIC change already contained in
// HEAD? Replay base->public onto HEAD with a 3-way merge; if that leaves HEAD
// unchanged and conflict-free, the change was already brought in.
function publicChangeContained(baseB, pubB, headB) {
  if (!baseB || !pubB || !headB) return false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5drift-'));
  try {
    const f = (n, b) => { const p = path.join(dir, n); fs.writeFileSync(p, execFileSync('git', ['cat-file', 'blob', b])); return p; };
    const head = f('head', headB), baseF = f('base', baseB), pubF = f('pub', pubB);
    const merged = execFileSync('git', ['merge-file', '-p', head, baseF, pubF], { stdio: ['ignore', 'pipe', 'ignore'] });
    return Buffer.compare(merged, fs.readFileSync(head)) === 0;
  } catch (e) {
    return false;                               // conflicts: git merge-file exits non-zero
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
// tools/public-drift-ack.txt: "<path> <public blob sha>  # why" - a SPECIFIC
// public version that the private repo deliberately supersedes. A later
// public edit of that file has a new blob sha and is flagged again.
const ack = new Set();
try {
  for (const l of fs.readFileSync(path.join(__dirname, 'public-drift-ack.txt'), 'utf8').split('\n')) {
    const m = l.replace(/#.*/, '').trim().split(/\s+/);
    if (m.length >= 2) ack.add(m[0] + ' ' + m[1]);
  }
} catch (e) { /* no acknowledgements */ }
const lost = [], conflict = [];
for (const p of git('diff', '--name-only', base, pub).split('\n').filter(Boolean)) {
  if (p.startsWith('private/')) continue;
  const pubB = blob(pub, p), baseB = blob(base, p), headB = blob('HEAD', p);
  if (pubB === headB) continue;                 // already in the private repo
  if (ack.has(p + ' ' + pubB)) continue;        // this public version is knowingly superseded
  if (headB === baseB) lost.push(p);            // private never took the public change
  else if (!publicChangeContained(baseB, pubB, headB)) conflict.push(p);   // both changed, public part missing
}
const who = git('log', '--format=%an', base + '..' + pub).split('\n').filter(Boolean);
if (!lost.length && !conflict.length) {
  console.log('public-drift: clean - every public change since ' + base.slice(0, 7) + ' is already in the private repo');
  process.exit(0);
}
console.error('\npublic-drift: the public repo has work that this release would ERASE');
console.error('  changed on public since the last release (' + base.slice(0, 7) + ') by: ' + [...new Set(who)].join(', '));
for (const p of lost) console.error('  NOT in private repo: ' + p);
for (const p of conflict) console.error('  changed on BOTH sides: ' + p);
console.error('\nBring those changes into the private repo first, e.g.:');
console.error('  git checkout radware/main -- <path>      (take the public version of a file)');
console.error('  or merge/port the contributor branch, then commit and rerun the release.');
console.error('If the private version deliberately SUPERSEDES a public file, acknowledge that exact version in');
console.error('tools/public-drift-ack.txt:');
for (const p of conflict) console.error('  ' + p + ' ' + blob(pub, p) + '  # <why the private version wins>');
console.error('');
process.exit(1);
