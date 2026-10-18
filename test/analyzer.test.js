import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeProjects } from '../src/analyzer.js';
import { makeFilter } from '../src/utils.js';

function project(name, deps, { lockfile = null, dev = null, peer = null, optional = null, path = name } = {}) {
  const pkg = { name };
  if (deps) pkg.dependencies = deps;
  if (dev) pkg.devDependencies = dev;
  if (peer) pkg.peerDependencies = peer;
  if (optional) pkg.optionalDependencies = optional;
  return { name, relativePath: `./${path}`, absolutePath: `/x/${path}/package.json`, pkg, lockfile };
}

describe('analyzeProjects', () => {
  it('prefers lockfile versions over declared ranges', () => {
    const lockfile = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a]);
    const cell = analysis.dependencies.rows.get('axios').get(a.absolutePath);
    assert.equal(cell.version, '1.7.2');
    assert.equal(cell.source, 'package-lock.json');
    assert.equal(cell.declared, '^1.6.0');
    assert.equal(cell.resolved, '1.7.2');
  });

  it('--declared ignores lockfiles', () => {
    const lockfile = { type: 'package-lock.json', versions: new Map([['axios', '1.7.2']]) };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a], { useDeclared: true });
    const cell = analysis.dependencies.rows.get('axios').get(a.absolutePath);
    assert.equal(cell.version, '^1.6.0');
    assert.equal(cell.source, 'package.json');
    assert.equal(cell.resolved, null);
  });

  it('falls back to package.json for packages missing from the lockfile', () => {
    const lockfile = { type: 'yarn.lock', versions: new Map() };
    const a = project('a', { axios: '^1.6.0' }, { lockfile });
    const analysis = analyzeProjects([a]);
    assert.equal(analysis.dependencies.rows.get('axios').get(a.absolutePath).source, 'package.json');
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
    assert.equal(full.peerDependencies.rows.get('react').get(a.absolutePath).version, '^18.0.0');
    assert.equal(full.optionalDependencies.rows.get('fsevents').get(a.absolutePath).version, '^2.3.0');
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

  it('keeps projects with the same name separate in every dependency set', () => {
    const a = project('api', { react: '17.0.2' }, {
      path: 'first', dev: { tool: '1.0.0' }, peer: { peer: '^1' }, optional: { extra: '1.0.0' },
    });
    const b = project('api', { react: '18.3.1' }, {
      path: 'second', dev: { tool: '2.0.0' }, peer: { peer: '^2' }, optional: { extra: '2.0.0' },
    });
    const analysis = analyzeProjects([a, b], { includeDev: true, includePeer: true, includeOptional: true });
    assert.deepEqual(analysis.mismatches, ['extra', 'peer', 'react', 'tool']);
    assert.equal(analysis.dependencies.rows.get('react').get(a.absolutePath).version, '17.0.2');
    assert.equal(analysis.dependencies.rows.get('react').get(b.absolutePath).version, '18.3.1');
    assert.deepEqual(analysis.dependencies.projects, [a.absolutePath, b.absolutePath]);
    assert.deepEqual([...analysis.dependencies.projectLabels.values()], ['api (./first)', 'api (./second)']);
    const reversed = analyzeProjects([b, a]);
    assert.deepEqual(reversed.dependencies.rows.get('react'), analysis.dependencies.rows.get('react'));
  });

  it('falls back to declared when contextual resolution is unknown, even if a transitive version exists', () => {
    const a = project('a', { lodash: '^4.17.0' }, {
      lockfile: { type: 'yarn.lock', versions: new Map([['lodash', '3.10.1']]), resolveVersion: () => undefined },
    });
    const cell = analyzeProjects([a]).dependencies.rows.get('lodash').get(a.absolutePath);
    assert.deepEqual(cell, { version: '^4.17.0', declared: '^4.17.0', source: 'package.json', resolved: null });
  });

  it('passes the dependency section and its declaration to contextual resolution', () => {
    const a = project('a', { react: '^18' }, {
      peer: { react: '^17 || ^18' },
      lockfile: {
        type: 'yarn.lock',
        resolveVersion(name, declared, field) {
          return name === 'react' && declared === '^18' && field === 'dependencies' ? '18.3.1' : undefined;
        },
      },
    });
    const analysis = analyzeProjects([a], { includePeer: true });
    assert.equal(analysis.dependencies.rows.get('react').get(a.absolutePath).resolved, '18.3.1');
    assert.equal(analysis.peerDependencies.rows.get('react').get(a.absolutePath).version, '^17 || ^18');
  });

  it('can compare only development dependencies without a production matrix', () => {
    const a = project('a', { prod: '1.0.0' }, { dev: { tool: '^1.0.0' } });
    const b = project('b', { prod: '2.0.0' }, { dev: { tool: '~1.2.0' } });
    const analysis = analyzeProjects([a, b], { includeProd: false, includeDev: true });
    assert.equal(analysis.dependencies, null);
    assert.equal(analysis.comparison, 'compatible');
    assert.deepEqual(analysis.mismatches, []);
    assert.deepEqual(analysis.compatible, ['tool']);
    assert.deepEqual(analysis.devDependencies.packages, ['tool']);
  });

  it('applies exact policy to every selected dependency section and keeps peer contracts', () => {
    const lockfile = { type: 'package-lock.json', versions: new Map([['react', '19.0.0']]) };
    const a = project('a', { dep: '^1.0.0' }, { dev: { dev: '^1.0.0' }, peer: { react: '^18.0.0' }, optional: { optional: '^1.0.0' }, lockfile });
    const b = project('b', { dep: '~1.2.0' }, { dev: { dev: '~1.2.0' }, peer: { react: '~18.2.0' }, optional: { optional: '~1.2.0' }, lockfile });
    const analysis = analyzeProjects([a, b], { comparison: 'exact', includeDev: true, includePeer: true, includeOptional: true });
    assert.equal(analysis.comparison, 'exact');
    assert.deepEqual(analysis.mismatches, ['dep', 'dev', 'optional', 'react']);
    assert.deepEqual(analysis.compatible, []);
    assert.equal(analysis.peerDependencies.rows.get('react').get(a.absolutePath).resolved, null);
  });

  it('reports a global range conflict even when every project pair overlaps', () => {
    const analysis = analyzeProjects([
      project('a', { shared: '1 || 2' }), project('b', { shared: '2 || 3' }), project('c', { shared: '1 || 3' }),
    ]);
    assert.deepEqual(analysis.mismatches, ['shared']);
    assert.deepEqual(analysis.compatible, []);
  });

  it('rejects unknown comparison policies before building matrices', () => {
    assert.throws(() => analyzeProjects([], { comparison: 'strict' }), /Invalid comparison policy/);
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
