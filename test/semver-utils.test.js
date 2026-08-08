import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
