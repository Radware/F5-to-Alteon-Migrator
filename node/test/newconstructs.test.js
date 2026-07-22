'use strict';
// Regression fixture for the real-config-driven constructs (GAP-1..GAP-10 +
// BUG-8): weight/ratio, state user-down, drain mode, maxcon with inline mode,
// built-in monitor aliases, min-N-of LOGEXP, built-in profile mappings.
// The expected output was LIVE-VALIDATED on Alteon 34.5.7.0 with ZERO errors
// (validation/results/report_newconstructs_34_5_7_0.json) — every object
// staged exactly as generated (confirmed via `diff` on the device).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../lib/index');

const FIX = path.join(__dirname, '..', '..', 'fixtures', 'newconstructs');

test('newconstructs fixture matches its live-validated frozen output byte-for-byte', () => {
  const out = migrate([fs.readFileSync(path.join(FIX, 'bigip.conf'), 'utf8')]).output;
  assert.strictEqual(out, fs.readFileSync(path.join(FIX, 'expected-node', 'output.txt'), 'utf8'));
});
