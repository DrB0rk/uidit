import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('help flags print usage and exit without starting server processes', () => {
  for (const flag of ['--help', '-h']) {
    const result = spawnSync(process.execPath, ['bin/uidit.js', flag], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(result.status, 0, `${flag} should exit successfully`);
    assert.match(result.stdout, /local UI review dashboard/);
    assert.doesNotMatch(result.stdout, /dashboard →/);
    assert.equal(result.stderr, '');
  }
});
