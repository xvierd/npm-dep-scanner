import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjects } from '../src/analyzer.js';
import { makeFilter } from '../src/utils.js';

function project(name, deps, { lockfile = null, dev = null, peer = null, optional = null } = {}) {
  const pkg = { name };
  if (deps) pkg.dependencies = deps;
  if (dev) pkg.devDependencies = dev;
  if (peer) pkg.peerDependencies = peer;
  if (optional) pkg.optionalDependencies = optional;
  return { name, relativePath: `./${name}`, absolutePath: `/x/${name}/package.json`, pkg, lockfile };
}

describe('analyzeProjects', () => {
  it('prefers lockfile versions over declared ranges', () => {
    const lockfile = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a]);
    const cell = analysis.dependencies.rows.get('axios').get('a');
    assert.equal(cell.version, '1.7.2');
    assert.equal(cell.source, 'package-lock.json');
    assert.equal(cell.declared, '^1.6.0');
  });

  it('--declared ignores lockfiles', () => {
    const lockfile = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a], { useDeclared: true });
    const cell = analysis.dependencies.rows.get('axios').get('a');
    assert.equal(cell.version, '^1.6.0');
    assert.equal(cell.source, 'package.json');
  });

  it('falls back to package.json for packages missing from the lockfile', () => {
    const lockfile = { type: 'yarn.lock', versions: new Map() };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a]);
    assert.equal(analysis.dependencies.rows.get('axios').get('a').source, 'package.json');
  });

  it('flags semver-compatible ranges as compatible, not mismatch', () => {
    const a = project('a', { axios: '^1.6.0' });
    const b = project('b', { axios: '~1.6.8' });
    const analysis = analyzeProjects([a, b]);
    assert.deepEqual(analysis.mismatches, []);
    assert.deepEqual(analysis.compatible, ['axios']);
    assert.equal(analysis.dependencies.status.get('axios'), 'compatible');
  });

  it('flags incompatible ranges as mismatch', () => {
    const a = project('a', { axios: '^1.6.0' });
    const b = project('b', { axios: '^2.0.0' });
    const analysis = analyzeProjects([a, b]);
    assert.deepEqual(analysis.mismatches, ['axios']);
    assert.deepEqual(analysis.compatible, []);
  });

  it('lockfile versions can turn a declared mismatch into a match', () => {
    // Both declare different ranges but the same version got installed.
    const lfA = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const lfB = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const a = project('a', { axios: '^1.6.0' }, { lockfile: lfA });
    const b = project('b', { axios: '^1.7.0' }, { lockfile: lfB });
    const analysis = analyzeProjects([a, b]);
    assert.deepEqual(analysis.mismatches, []);
    assert.deepEqual(analysis.compatible, []);
  });

  it('includes peer and optional dependencies only when requested', () => {
    const a = project('a', { axios: '^1.6.0' }, { peer: { react: '^18.0.0' }, optional: { fsevents: '^2.3.0' } });
    const base = analyzeProjects([a]);
    assert.equal(base.peerDependencies, null);
    assert.equal(base.optionalDependencies, null);

    const full = analyzeProjects([a], { includePeer: true, includeOptional: true });
    assert.equal(full.peerDependencies.rows.get('react').get('a').version, '^18.0.0');
    assert.equal(full.optionalDependencies.rows.get('fsevents').get('a').version, '^2.3.0');
  });

  it('mismatchesOnly removes match and compatible rows', () => {
    const a = project('a', { axios: '^1.6.0', zod: '^3.22.0', lodash: '^4.17.21' });
    const b = project('b', { axios: '~1.6.8', zod: '~3.20.0', lodash: '^4.17.21' });
    const analysis = analyzeProjects([a, b], { mismatchesOnly: true });
    assert.deepEqual(analysis.dependencies.packages, ['zod']); // axios is compatible, lodash matches
    assert.deepEqual(analysis.mismatches, ['zod']);
  });

  it('applies a name filter', () => {
    const a = project('a', { axios: '^1.6.0', zod: '^3.22.0' });
    const analysis = analyzeProjects([a], { filter: makeFilter('ax') });
    assert.deepEqual(analysis.dependencies.packages, ['axios']);
  });

  it('collects mismatches across dependency sets', () => {
    const a = project('a', { axios: '^1.6.0' }, { dev: { jest: '^29.0.0' }, peer: { react: '^17.0.0' } });
    const b = project('b', { axios: '^1.6.0' }, { dev: { jest: '^29.0.0' }, peer: { react: '^18.0.0' } });
    const analysis = analyzeProjects([a, b], { includeDev: true, includePeer: true });
    assert.deepEqual(analysis.mismatches, ['react']);
  });
});

describe('makeFilter', () => {
  it('plain text matches as substring, case-insensitive', () => {
    const f = makeFilter('Ax');
    assert.equal(f('axios'), true);
    assert.equal(f('zod'), false);
  });

  it('supports glob patterns', () => {
    const f = makeFilter('react-*');
    assert.equal(f('react-dom'), true);
    assert.equal(f('react'), false);
    const g = makeFilter('@scope/*');
    assert.equal(g('@scope/pkg'), true);
    assert.equal(g('other'), false);
  });

  it('returns null without a pattern', () => {
    assert.equal(makeFilter(undefined), null);
  });
});
