import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));

void test('parses flags with or without a runner separator after the command', () => {
  for (const separator of [[], ['--']]) {
    const help = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        cli,
        'scrape',
        ...separator,
        '--category',
        'chest',
        '--limit',
        '5',
        '--help',
      ],
      { encoding: 'utf8' },
    );
    assert.ifError(help.error);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /vp run initial-data:scrape/);
    for (const command of ['scrape', 'sync']) {
      const invalid = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, command, ...separator, '--category', 'chest', '--limit', '0'],
        { encoding: 'utf8' },
      );
      assert.ifError(invalid.error);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /--limit must be a positive integer/);
    }
  }
});
