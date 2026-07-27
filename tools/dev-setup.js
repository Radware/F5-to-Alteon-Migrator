#!/usr/bin/env node
'use strict';
// Runs from the npm "prepare" script, i.e. the first thing a developer does
// after cloning (npm install). Two jobs:
//
//   1. If this is a clone of the PUBLIC mirror, say so loudly - development
//      belongs in the private repo, and access comes from the maintainer.
//   2. Otherwise arm the pre-push guard automatically, so the two-repo rule
//      cannot be lost by cloning fresh.
//
// Never fails the install: it exits 0 whatever happens.
const { execSync } = require('child_process');

const git = (cmd) => {
  try { return execSync('git ' + cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (e) { return ''; }
};

try {
  const remotes = git('remote -v');
  if (!remotes) process.exit(0);                      // not a git checkout

  const hasPrivate = /rdwr-seanr\/F5-to-Alteon-Migrator/i.test(remotes);
  const hasPublic = /[Rr]adware\/F5-to-Alteon-Migrator/.test(remotes);

  if (hasPublic && !hasPrivate) {
    console.log([
      '',
      '  ' + '='.repeat(70),
      '  NOTE: this is the PUBLISHED mirror, not the development repository.',
      '  ' + '='.repeat(70),
      '',
      '  Radware/F5-to-Alteon-Migrator receives sanitized snapshots from a',
      '  private repo where all development happens. Anything committed here',
      '  is overwritten by the next release.',
      '',
      '    * Bug, wrong conversion, missing capability?',
      '      Please open an issue - that is the right channel, and it is how',
      '      most of this tool got fixed:',
      '      https://github.com/Radware/F5-to-Alteon-Migrator/issues/new/choose',
      '',
      '    * Want to contribute code?',
      '      Open a pull request here for discussion, or request access to the',
      '      development repository from the maintainer, Sean Ramati',
      '      (seanr@radware.com). Please do not develop against this mirror.',
      '',
      '  See PUBLISHING.md and CONTRIBUTING.md.',
      '',
    ].join('\n'));
    process.exit(0);
  }

  if (hasPrivate) {
    const current = git('config core.hooksPath');
    if (current !== '.githooks') {
      git('config core.hooksPath .githooks');
      console.log('\n  dev-setup: pre-push guard enabled (core.hooksPath=.githooks).');
      console.log('  Publish with tools/publish-public.ps1 - see PUBLISHING.md.\n');
    }
  }
} catch (e) { /* never break an install */ }
process.exit(0);
