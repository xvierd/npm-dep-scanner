import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeProjects } from '../src/analyzer.js';
import { report, toJsonReport, errorJsonReport } from '../src/reporter.js';
import { printDiff } from '../src/differ.js';
import { writeHtmlReport } from '../src/html-report.js';

function project(name, path, version) {
  return {
    name, relativePath: `./${path}`, absolutePath: `/projects/${path}/package.json`,
    pkg: { dependencies: { react: version } },
  };
}

function capture(t, callback) {
  const lines = [];
  const mock = t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  try {
    callback();
    return lines.join('\n');
  } finally {
    mock.mock.restore();
  }
}

describe('reports with project identities', () => {
  it('preserves both versions and their paths in JSON for duplicate names', (t) => {
    const analysis = analyzeProjects([project('api', 'first', '17.0.2'), project('api', 'second', '18.3.1')]);
    const result = JSON.parse(capture(t, () => report(analysis, { json: true })));
    assert.equal(result.dependencies.react.status, 'mismatch');
    assert.equal(result.dependencies.react.versions.first.version, '17.0.2');
    assert.equal(result.dependencies.react.versions.second.version, '18.3.1');
    assert.equal(result.projects.length, 2);
    assert.notEqual(result.projects[0].id, result.projects[1].id);
    assert.deepEqual(result.projects.map((p) => p.path), ['first', 'second']);
  });

  it('preserves status metadata and prototype-like names as ordinary data', (t) => {
    const projects = [project('status', 'status', '17.0.2'), project('__proto__', '__proto__', '18.3.1')];
    projects[0].pkg.dependencies = JSON.parse('{"__proto__":"1.0.0","react":"17.0.2"}');
    const result = JSON.parse(capture(t, () => report(analyzeProjects(projects), { json: true })));
    assert.equal(result.dependencies.react.status, 'mismatch');
    assert.equal(result.dependencies.react.versions.status.version, '17.0.2');
    assert.equal(result.dependencies.react.versions.__proto__.version, '18.3.1');
    assert.equal(result.dependencies.__proto__.status, 'match');
    assert.equal(result.dependencies.__proto__.versions.status.version, '1.0.0');
  });

  it('uses portable paths as JSON keys and preserves source metadata', (t) => {
    const result = JSON.parse(capture(t, () => report(analyzeProjects([project('api', 'first', '^18')]), { json: true })));
    assert.equal(result.dependencies.react.versions.first.version, '^18');
    assert.equal(result.dependencies.react.versions.first.declared, '^18');
    assert.equal(result.dependencies.react.versions.first.source, 'package.json');
    assert.equal(result.dependencies.react.versions.first.resolved, null);
  });

  it('disambiguates duplicate names in the table, diff and HTML', async (t) => {
    const analysis = analyzeProjects([project('api', 'first', '17.0.2'), project('api', 'second', '18.3.1')]);
    const table = capture(t, () => report(analysis));
    const diff = capture(t, () => printDiff(analysis));
    const directory = await mkdtemp(join(tmpdir(), 'npm-dep-report-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'report.html');
    await writeHtmlReport(analysis, file);
    const html = await readFile(file, 'utf8');
    for (const output of [table, diff, html]) {
      assert.match(output, /api \(\.\/first\)/);
      assert.match(output, /api \(\.\/second\)/);
      assert.match(output, /17\.0\.2/);
      assert.match(output, /18\.3\.1/);
    }
  });

  it('emits the complete schema v1 shape, explicit null cells and selected-section counts', () => {
    const a = project('api', 'a', '18.3.1');
    a.lockfile = { type: 'package-lock.json', versions: new Map([['react', '18.3.1']]) };
    a.pkg.dependencies.react = '^18.0.0';
    a.pkg.devDependencies = { tool: '^1.0.0' };
    const b = project('web', 'b', '^18.0.0');
    b.pkg.dependencies = { extra: '1.0.0', react: '^18.0.0' };
    b.pkg.devDependencies = { tool: '^2.0.0' };
    const result = toJsonReport(analyzeProjects([b, a], { includeDev: true }));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.comparison, 'compatible');
    assert.deepEqual(result.projects, [{ id: 'a', path: 'a', name: 'api' }, { id: 'b', path: 'b', name: 'web' }]);
    assert.deepEqual(result.dependencies.react.versions.a, {
      version: '18.3.1', declared: '^18.0.0', resolved: '18.3.1', source: 'package-lock.json',
    });
    assert.equal(result.dependencies.extra.versions.a, null);
    assert.equal(result.peerDependencies, null);
    assert.equal(result.optionalDependencies, null);
    assert.deepEqual(result.mismatches, ['tool']);
    assert.deepEqual(result.compatible, ['react']);
    assert.deepEqual(result.summary, { projects: 2, packages: 3, mismatches: 1, compatible: 1 });
    assert.deepEqual(result.errors, []);
  });

  it('is byte-for-byte deterministic when project order, dependency order and checkout root change', () => {
    const a = project('same', 'a', '18.0.0');
    const b = project('same', 'b', '19.0.0');
    a.pkg.dependencies = { zebra: '^1.0.0', react: '18.0.0', alpha: '1.0.0' };
    b.pkg.dependencies = { zebra: '^2.0.0', react: '19.0.0' };
    const first = JSON.stringify(toJsonReport(analyzeProjects([b, a])));
    const moved = [a, b].map((entry) => ({
      ...entry,
      absolutePath: entry.absolutePath.replace('/projects/', '/different/checkout/'),
      pkg: { dependencies: Object.fromEntries(Object.entries(entry.pkg.dependencies).reverse()) },
    }));
    const second = JSON.stringify(toJsonReport(analyzeProjects(moved)));
    assert.equal(first, second);
    assert.doesNotMatch(first, /\/projects\/|\/different\/|generatedAt|timestamp/);
    const result = JSON.parse(first);
    assert.deepEqual(Object.keys(result.dependencies), ['alpha', 'react', 'zebra']);
    assert.deepEqual(Object.keys(result.dependencies.react.versions), ['a', 'b']);
    assert.deepEqual(result.mismatches, ['react', 'zebra']);
  });

  it('normalizes root and Windows-style relative paths without leaking internal IDs', () => {
    const root = project('root', '.', '18.0.0');
    const child = project('child', 'packages/web', '18.0.0');
    child.relativePath = '.\\packages\\web';
    const result = toJsonReport(analyzeProjects([child, root]));
    assert.deepEqual(result.projects.map(({ id, path }) => [id, path]), [['.', '.'], ['packages/web', 'packages/web']]);
    assert.deepEqual(Object.keys(result.dependencies.react.versions), ['.', 'packages/web']);
  });

  it('rejects absolute or colliding portable JSON paths instead of leaking or overwriting them', () => {
    const a = project('a', 'a', '^18');
    for (const path of ['/private/checkout/a', '/', 'C:\\']) {
      a.relativePath = path;
      assert.throws(() => toJsonReport(analyzeProjects([a])), /relative to the scan root/);
    }
    const b = project('b', 'b', '^18');
    a.relativePath = './same';
    b.relativePath = 'same';
    assert.throws(() => toJsonReport(analyzeProjects([a, b])), /Duplicate relative project paths/);
  });

  it('uses null-prototype maps for package and project keys', () => {
    const a = project('__proto__', '__proto__', '18.0.0');
    a.pkg.dependencies = JSON.parse('{"__proto__":"1.0.0"}');
    const result = toJsonReport(analyzeProjects([a]));
    assert.equal(Object.getPrototypeOf(result.dependencies), null);
    assert.equal(Object.getPrototypeOf(result.dependencies.__proto__.versions), null);
    assert.equal(result.dependencies.__proto__.versions.__proto__.version, '1.0.0');
  });

  it('returns the same fixed top-level shape for successful and failed scans', () => {
    const success = toJsonReport(analyzeProjects([]));
    const failure = errorJsonReport(new Error('Cannot read manifest'), { comparison: 'exact', code: 'CONFIG_ERROR' });
    assert.deepEqual(Object.keys(failure), Object.keys(success));
    assert.equal(failure.schemaVersion, 1);
    assert.equal(failure.status, 'error');
    assert.equal(failure.comparison, 'exact');
    assert.deepEqual(failure.projects, []);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(failure[field], null);
    assert.deepEqual(failure.summary, { projects: 0, packages: 0, mismatches: 0, compatible: 0 });
    assert.deepEqual(failure.mismatches, []);
    assert.deepEqual(failure.compatible, []);
    assert.deepEqual(failure.errors, [{ code: 'CONFIG_ERROR', message: 'Cannot read manifest' }]);
    assert.deepEqual(errorJsonReport('bad').errors, [{ code: 'SCAN_ERROR', message: 'bad' }]);
    assert.throws(() => errorJsonReport('bad', { comparison: 'unknown' }), /Invalid comparison policy/);
  });

  it('supports development-only reports and applies exact policy in table, diff and HTML', async (t) => {
    const a = project('api', 'a', '1.0.0');
    const b = project('web', 'b', '1.0.0');
    a.pkg.devDependencies = { tool: '^1.0.0' };
    b.pkg.devDependencies = { tool: '~1.2.0' };
    const analysis = analyzeProjects([a, b], { includeProd: false, includeDev: true, comparison: 'exact' });
    const table = capture(t, () => report(analysis));
    const diff = capture(t, () => printDiff(analysis));
    const directory = await mkdtemp(join(tmpdir(), 'npm-dep-report-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, 'report.html');
    await writeHtmlReport(analysis, file);
    const html = await readFile(file, 'utf8');
    for (const output of [table, diff, html]) {
      assert.match(output, /tool/);
      assert.match(output, /\^1\.0\.0/);
      assert.match(output, /~1\.2\.0/);
      assert.doesNotMatch(output, /react/);
    }
    assert.match(html, /Comparison: exact/);
    assert.match(html, /<tr class="mismatch">/);
    assert.doesNotMatch(html, /green =/);
    const result = toJsonReport(analysis);
    assert.equal(result.dependencies, null);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.comparison, 'exact');
    assert.deepEqual(result.summary, { projects: 2, packages: 1, mismatches: 1, compatible: 0 });
    const compatibleDiff = capture(t, () => printDiff(analyzeProjects([a, b], { includeProd: false, includeDev: true })));
    assert.match(compatibleDiff, /No differences found/);
  });

  it('shows global range conflicts in diff even when every pair overlaps', (t) => {
    const analysis = analyzeProjects([
      project('a', 'a', '1 || 2'), project('b', 'b', '2 || 3'), project('c', 'c', '1 || 3'),
    ]);
    const output = capture(t, () => printDiff(analysis));
    assert.match(output, /No common version satisfies all project ranges/);
    assert.match(output, /react/);
    assert.doesNotMatch(output, /No differences found/);
  });

  it('identifies dependency sections when one package has opposite differences', (t) => {
    const a = project('a', 'a', '1.0.0');
    const b = project('b', 'b', '1.0.0');
    a.pkg = { dependencies: { foo: '1.0.0' }, devDependencies: { foo: '2.0.0' } };
    b.pkg = { dependencies: { foo: '2.0.0' }, devDependencies: { foo: '1.0.0' } };
    const output = capture(t, () => printDiff(analyzeProjects([a, b], { includeDev: true })));
    assert.match(output, /Section/);
    const rows = output.split('\n').filter((line) => line.includes('foo'));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /\bdependencies\s+│\s+foo\s+│\s+1\.0\.0\s+│\s+2\.0\.0/);
    assert.match(rows[1], /\bdevDependencies\s+│\s+foo\s+│\s+2\.0\.0\s+│\s+1\.0\.0/);
  });
});
