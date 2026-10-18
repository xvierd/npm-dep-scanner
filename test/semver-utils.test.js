import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import semver from 'semver';
import { classifyRow } from '../src/semver-utils.js';

describe('classifyRow', () => {
  it('match: identical values', () => {
    assert.equal(classifyRow(['^1.2.0', '^1.2.0']), 'match');
    assert.equal(classifyRow(['1.2.3', '1.2.3', '1.2.3']), 'match');
  });

  it('match: single value', () => {
    assert.equal(classifyRow(['^1.2.0']), 'match');
  });

  it('compatible: intersecting ranges', () => {
    assert.equal(classifyRow(['^1.2.0', '~1.2.3']), 'compatible');
    assert.equal(classifyRow(['^1.2.0', '1.2.0', '>=1.0.0 <2.0.0']), 'compatible');
    assert.equal(classifyRow(['^4.17.21', '*']), 'compatible');
  });

  it('compatible: exact version satisfies range', () => {
    assert.equal(classifyRow(['1.6.8', '^1.6.0']), 'compatible');
    assert.equal(classifyRow(['^1.6.0', '1.7.2']), 'compatible');
  });

  it('mismatch: different majors', () => {
    assert.equal(classifyRow(['^1.2.0', '^2.0.0']), 'mismatch');
    assert.equal(classifyRow(['1.2.3', '2.0.0']), 'mismatch');
  });

  it('mismatch: exact version outside range', () => {
    assert.equal(classifyRow(['^1.6.0', '2.0.1']), 'mismatch');
    assert.equal(classifyRow(['~1.2.0', '^1.3.0']), 'mismatch');
  });

  it('opaque values only match when identical', () => {
    assert.equal(classifyRow(['workspace:*', 'workspace:*']), 'match');
    assert.equal(classifyRow(['workspace:*', '^1.0.0']), 'mismatch');
    assert.equal(classifyRow(['latest', '^1.0.0']), 'mismatch');
    assert.equal(classifyRow(['file:../x', 'file:../x']), 'match');
  });

  it('does not accept prereleases unless the range explicitly includes them', () => {
    assert.equal(classifyRow(['^1.0.0', '1.1.0-beta.1']), 'mismatch');
    assert.equal(classifyRow(['1.1.0-beta.1', '^1.0.0']), 'mismatch');
    assert.equal(classifyRow(['^1.1.0-beta.1', '1.1.0-beta.2']), 'compatible');
  });

  it('supports exact string comparison, including semver-compatible ranges', () => {
    assert.equal(classifyRow(['^1.0.0', '^1.0.0'], 'exact'), 'match');
    assert.equal(classifyRow(['^1.0.0', '~1.2.0'], 'exact'), 'mismatch');
    assert.equal(classifyRow(['^1.0.0', '1.2.3'], 'exact'), 'mismatch');
    assert.equal(classifyRow(['workspace:*', 'workspace:*'], 'exact'), 'match');
    assert.equal(classifyRow(['', '*'], 'exact'), 'mismatch');
  });

  it('rejects invalid policies even for empty or matching rows', () => {
    assert.throws(() => classifyRow([], 'unknown'), /Invalid comparison policy/);
    assert.throws(() => classifyRow(['1.0.0', '1.0.0'], null), /Invalid comparison policy/);
  });

  it('requires one common version across all projects, not just each pair', () => {
    assert.equal(classifyRow(['1 || 2', '2 || 3', '1 || 3']), 'mismatch');
    assert.equal(classifyRow(['1 || 2 || 3', '2 || 3', '1 || 3']), 'compatible');
    assert.equal(classifyRow(['^1 || ^2', '>=1 <3', '>1.5.0 <2']), 'compatible');
  });

  it('handles open bounds and prerelease eligibility independently for every range', () => {
    assert.equal(classifyRow(['>1.0.0 <1.0.1', '>=1']), 'mismatch');
    assert.equal(classifyRow(['>1.0.0 <1.0.2', '>=1']), 'compatible');
    assert.equal(classifyRow(['>1.0.0-beta.1 <1.0.0-beta.2', '<1.0.0-beta.2']), 'compatible');
    assert.equal(classifyRow(['>=1.0.0-beta.1 <1.0.0', '*']), 'mismatch');
    assert.equal(classifyRow(['>=1.0.0-beta.1 <1.0.0', '<1.0.0-beta.2']), 'compatible');
    assert.equal(classifyRow(['>=1.0.0-beta.1', '>=1.0.0']), 'compatible');
  });

  it('preserves differences between distinct exact version strings', () => {
    assert.equal(classifyRow(['1.0.0+one', '1.0.0+two']), 'mismatch');
    assert.equal(classifyRow(['v1.0.0', '1.0.0']), 'mismatch');
  });

  it('finds valid prerelease successors at the 255 and 256 character limits', () => {
    const lower255 = `1.0.0-${'a'.repeat(249)}`;
    const lower256 = `${lower255}a`;
    const successor256 = `${lower255}b`;
    const admitsPrereleases = '>=1.0.0-0 <1.0.0';
    assert.equal(semver.valid(`${lower255}.0`), null);
    assert.ok(semver.satisfies(`${lower255}-`, `>${lower255} <${lower255}0`));
    assert.equal(classifyRow([`>${lower255} <${lower255}0`, admitsPrereleases]), 'compatible');
    assert.equal(classifyRow([`>${lower256} <${lower255}c`, admitsPrereleases]), 'compatible');
    assert.equal(classifyRow([`>${lower256} <${successor256}`, admitsPrereleases]), 'mismatch');
  });

  it('advances an earlier prerelease identifier when the final identifier is all z', () => {
    const lower = `1.0.0-alpha.${'z'.repeat(244)}`;
    assert.equal(lower.length, 256);
    assert.ok(semver.satisfies('1.0.0-alpha-', `>${lower} <1.0.0-alpha0`));
    assert.equal(classifyRow([`>${lower} <1.0.0-alpha0`, '>=1.0.0-0 <1.0.0']), 'compatible');
    const punctuation = `1.0.0--.${'z'.repeat(248)}`;
    assert.equal(classifyRow([`>${punctuation} <1.0.0-0A`, '>=1.0.0-0 <1.0.0']), 'compatible');
  });

  it('advances numeric prerelease identifiers without skipping a narrow valid interval', () => {
    const prefix = `1.0.0-${'a'.repeat(233)}.`;
    const lower = `${prefix}9007199254740992`;
    const successor = `${prefix}9007199254740994`;
    const upper = `${prefix}9007199254740996`;
    assert.equal(lower.length, 256);
    assert.ok(semver.satisfies(successor, `>${lower} <${upper}`));
    assert.equal(classifyRow([`>${lower} <${upper}`, '>=1.0.0-0 <1.0.0']), 'compatible');
    assert.equal(classifyRow([`>${lower} <${successor}`, '>=1.0.0-0 <1.0.0']), 'mismatch');
    const largestNumeric = `1.0.0-${'9'.repeat(250)}`;
    assert.equal(classifyRow([`>${largestNumeric} <1.0.0--0`, '>=1.0.0-0 <1.0.0']), 'compatible');
    assert.equal(classifyRow([`>${largestNumeric} <1.0.0--`, '>=1.0.0-0 <1.0.0']), 'mismatch');
  });

  it('agrees with enumerated witnesses for combinations of unions and prerelease ranges', () => {
    const ranges = [
      '1 || 2', '2 || 3', '1 || 3', '>=1 <3', '>1.0.0 <1.0.2',
      '>=1.0.0-beta.1 <1.0.0', '>1.0.0-beta.1 <1.0.0-beta.2', '<1.0.0-beta.2', '>=2 <3',
    ];
    const witnesses = [
      '0.0.0', '0.9.0', '1.0.0-0', '1.0.0-beta.1', '1.0.0-beta.1.0',
      '1.0.0-beta.2', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '2.1.0', '3.0.0',
    ];
    for (let a = 0; a < ranges.length; a++) {
      for (let b = a; b < ranges.length; b++) {
        for (let c = b; c < ranges.length; c++) {
          const values = [ranges[a], ranges[b], ranges[c]];
          const intersects = witnesses.some((version) => values.every((range) => semver.satisfies(version, range)));
          const expected = new Set(values).size === 1 ? 'match' : intersects ? 'compatible' : 'mismatch';
          assert.equal(classifyRow(values), expected, values.join(' AND '));
        }
      }
    }
  });
});
