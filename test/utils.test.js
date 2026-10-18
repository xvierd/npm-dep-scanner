import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeFilter } from '../src/utils.js';

describe('safe package filters', () => {
  it('preserves case-insensitive substring and full wildcard matching', () => {
    assert.equal(makeFilter('React')('@scope/react-dom'), true);
    assert.equal(makeFilter('REACT-*')('react-dom'), true);
    assert.equal(makeFilter('react-*')('@scope/react-dom'), false);
    assert.equal(makeFilter('@scope/?')('@scope/a'), true);
    assert.equal(makeFilter('@scope/?')('@scope/ab'), false);
    assert.equal(makeFilter('*a')('*ba'), true);
    assert.equal(makeFilter('*')(''), true);
  });

  it('treats regex syntax as literal text', () => {
    assert.equal(makeFilter('*(a+)+')('prefix(a+)+'), true);
    assert.equal(makeFilter('*(a+)+')('aaaa'), false);
    assert.equal(makeFilter('[ab]*')('[ab]-name'), true);
    assert.equal(makeFilter('[ab]*')('a-name'), false);
  });

  it('handles repetitive malicious wildcards without a regex engine', () => {
    // A child deadline also catches a future synchronous ReDoS regression;
    // node:test timeouts cannot interrupt a blocked main thread.
    const source = `
      import assert from 'node:assert/strict';
      import { makeFilter } from ${JSON.stringify(new URL('../src/utils.js', import.meta.url).href)};
      assert.equal(makeFilter('*a'.repeat(100) + 'b')('a'.repeat(50000)), false);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', timeout: 3000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.throws(() => makeFilter('*'.repeat(1025)), /1024/);
  });
});
