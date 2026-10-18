import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchPatterns, validatePatterns } from '../src/patterns.js';

describe('matchPatterns', () => {
  it('matches package names and preserves input order without duplicates', async () => {
    const values = ['react', '@scope/api', 'react-dom', 'react', 'lodash'];
    assert.deepEqual(await matchPatterns(values, ['react*', '@scope/*']), ['react', '@scope/api', 'react-dom']);
  });

  it('applies ordered exclusions and preserves leading negative extglobs', async () => {
    const values = ['packages/a', 'packages/b', 'other'];
    assert.deepEqual(await matchPatterns(values, ['packages/*', '!packages/b']), ['packages/a']);
    assert.deepEqual(await matchPatterns(values, ['!packages/b', 'packages/b']), ['packages/b']);
    assert.deepEqual(await matchPatterns(values, ['!packages/b']), ['packages/a', 'other']);
    assert.deepEqual(await matchPatterns(['a', 'excluded'], ['!(excluded)']), ['a']);
  });

  it('matches multi-digit, padded, descending, signed and stepped ranges', async () => {
    const cases = [
      { values: ['9', '10', '11', '12', '13'], pattern: '{9..12}', expected: ['9', '10', '11', '12'] },
      { values: ['1', '01', '02', '03', '04'], pattern: '{01..03}', expected: ['01', '02', '03'] },
      { values: ['1', '2', '3', '4', '5'], pattern: '{5..1..2}', expected: ['1', '3', '5'] },
      { values: ['-2', '-1', '0', '1', '2', '3'], pattern: '{-2..2}', expected: ['-2', '-1', '0', '1', '2'] },
      { values: ['a', 'b', 'c', 'd', 'e'], pattern: '{a..e..2}', expected: ['a', 'c', 'e'] },
    ];
    for (const { values, pattern, expected } of cases) assert.deepEqual(await matchPatterns(values, [pattern]), expected);
  });

  it('supports brace alternatives, extglobs and explicit hidden-file matching', async () => {
    assert.deepEqual(await matchPatterns(['api/a', 'web/b', 'lib/c'], ['{api,web}/@(a|b)']), ['api/a', 'web/b']);
    assert.deepEqual(await matchPatterns(['.hidden', 'visible'], ['*']), ['visible']);
    assert.deepEqual(await matchPatterns(['.hidden', 'visible'], ['*'], { dot: true }), ['.hidden', 'visible']);
  });

  it('validates before invoking the worker, including for empty candidate lists', async () => {
    assert.throws(() => validatePatterns(['{1..1000000}'], { label: 'exclude' }), /Invalid exclude: expansion budget/);
    await assert.rejects(matchPatterns([], ['[broken']), /Invalid patterns: unbalanced/);
    assert.deepEqual(await matchPatterns(['anything'], []), []);
  });
});
