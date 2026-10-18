import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(directory, ...args) {
  return spawnSync(process.execPath, [join(root, 'bin/cli.js'), directory, ...args], {
    input: '', encoding: 'utf8', timeout: 5000,
  });
}

async function fixture(t, rootPackage = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'npm-dep-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'root', ...rootPackage }));
  return directory;
}

async function project(directory, path, pkg) {
  await mkdir(join(directory, path), { recursive: true });
  await writeFile(join(directory, path, 'package.json'), JSON.stringify(pkg));
}

async function configuration(directory, config) {
  await writeFile(join(directory, '.npm-dep-scanner.json'), JSON.stringify(config));
}

function jsonResult(result, exitCode, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, exitCode, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.status, status);
  assert.deepEqual(Object.keys(data), [
    'schemaVersion', 'status', 'comparison', 'projects', 'dependencies', 'devDependencies',
    'peerDependencies', 'optionalDependencies', 'mismatches', 'compatible', 'summary', 'errors',
  ]);
  return data;
}

describe('CLI regression checks', () => {
  it('--json produces JSON without requiring --all or a terminal', () => {
    const result = run(join(root, 'test/fixtures'), '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.error, undefined);
    const data = JSON.parse(result.stdout);
    assert.ok(data.dependencies.axios);
    assert.equal(result.stderr, '');
  });

  it('completes a report with stdin closed and no flags', () => {
    const result = run(join(root, 'test/fixtures'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dependencies:/);
    assert.doesNotMatch(result.stdout, /Select projects|How would you like/);
  });

  it('compares shared workspace lock resolutions even when project names are equal', async (t) => {
    const directory = await fixture(t, { workspaces: ['packages/*'] });
    for (const name of ['first', 'second']) {
      await mkdir(join(directory, 'packages', name), { recursive: true });
      await writeFile(join(directory, 'packages', name, 'package.json'), JSON.stringify({
        name: 'api', dependencies: { react: '^18.2.0' },
      }));
    }
    await writeFile(join(directory, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root' },
        'packages/first': { dependencies: { react: '^18.2.0' } },
        'packages/second': { dependencies: { react: '^18.2.0' } },
        'node_modules/react': { version: '18.2.0' },
        'packages/second/node_modules/react': { version: '18.3.1' },
      },
    }));
    const result = run(directory, '--json');
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.mismatches, ['react']);
    assert.equal(data.dependencies.react.versions['packages/first'].resolved, '18.2.0');
    assert.equal(data.dependencies.react.versions['packages/second'].resolved, '18.3.1');
    assert.equal(data.dependencies.react.versions['packages/first'].declared, '^18.2.0');
    assert.equal(data.dependencies.react.versions['packages/first'].source, 'package-lock.json');
    const declared = run(directory, '--json', '--declared');
    assert.equal(declared.status, 0, declared.stderr);
    const declaredData = JSON.parse(declared.stdout);
    assert.deepEqual(declaredData.mismatches, []);
    assert.equal(declaredData.dependencies.react.versions['packages/first'].resolved, null);
  });

  it('rejects deeply nested workspace patterns promptly with a clear error', async (t) => {
    const pattern = 'packages/' + '{'.repeat(400) + 'a,b' + '}'.repeat(400);
    const directory = await fixture(t, { workspaces: [pattern] });
    const result = run(directory, '--json');
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, 'error');
    assert.match(result.stderr, /workspace.*pattern|pattern.*workspace/i);
    assert.doesNotMatch(result.stderr, /RangeError|at .*\.js:\d+/);
  });

  it('fails instead of reporting consistency when a discovered manifest is invalid', async (t) => {
    const directory = await fixture(t);
    await mkdir(join(directory, 'broken'));
    await writeFile(join(directory, 'broken/package.json'), '{"name":"broken",}');
    const result = run(directory, '--json');
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, 'error');
    assert.match(result.stderr, /Cannot read package manifest.*broken[\\/]package\.json/);
  });

  it('rejects dependency declarations that are not version strings', async (t) => {
    const directory = await fixture(t, { dependencies: { react: 18 } });
    const result = run(directory, '--json');
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, 'error');
    assert.match(result.stderr, /dependencies must map package names/);
  });

  it('--declared ignores a malformed lockfile while normal mode reports it', async (t) => {
    const directory = await fixture(t, { dependencies: { react: '^18' } });
    await writeFile(join(directory, 'package-lock.json'), '{invalid');
    const normal = run(directory, '--json');
    assert.equal(normal.status, 2);
    assert.match(normal.stderr, /Cannot parse lockfile.*package-lock\.json/);
    const declared = run(directory, '--json', '--declared');
    assert.equal(declared.status, 0, declared.stderr);
    const data = JSON.parse(declared.stdout);
    assert.equal(data.dependencies.react.versions['.'].version, '^18');
    assert.equal(data.dependencies.react.versions['.'].resolved, null);
  });
});

describe('CI and shared configuration', () => {
  it('--check never opens prompts even when both streams report a terminal', async (t) => {
    const directory = await fixture(t, { dependencies: { shared: '1.0.0' } });
    await project(directory, 'app', { name: 'app', dependencies: { shared: '2.0.0' } });
    const preload = 'process.stdin.isTTY = true; process.stdout.isTTY = true;';
    const result = spawnSync(process.execPath, [
      '--import', 'data:text/javascript,' + encodeURIComponent(preload),
      join(root, 'bin/cli.js'), directory, '--check',
    ], { input: '', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /version mismatch/);
    assert.doesNotMatch(result.stdout, /Select projects|Which dependency|How would you like/);
  });

  it('--check returns 0 for compatible ranges, 1 for exact differences and never prompts', async (t) => {
    const directory = await fixture(t, { dependencies: { react: '^18.2.0' } });
    await project(directory, 'app', { name: 'app', dependencies: { react: '~18.2.0' } });
    const compatible = jsonResult(run(directory, '--check', '--json'), 0, 'ok');
    assert.deepEqual(compatible.compatible, ['react']);
    const exact = jsonResult(run(directory, '--check', '--json', '--comparison', 'exact'), 1, 'mismatch');
    assert.deepEqual(exact.mismatches, ['react']);
    assert.equal(exact.comparison, 'exact');
    jsonResult(run(directory, '--json', '--comparison', 'exact'), 0, 'mismatch');
    const text = run(directory, '--check', '--comparison', 'exact');
    assert.equal(text.status, 1, text.stderr);
    assert.doesNotMatch(text.stdout, /Select projects|Which dependency|How would you like/);
  });

  it('fails CI when three ranges overlap in pairs but have no shared version', async (t) => {
    const directory = await fixture(t, { dependencies: { shared: '1 || 2' } });
    await project(directory, 'b', { name: 'b', dependencies: { shared: '2 || 3' } });
    await project(directory, 'c', { name: 'c', dependencies: { shared: '1 || 3' } });
    const data = jsonResult(run(directory, '--check', '--json'), 1, 'mismatch');
    assert.deepEqual(data.mismatches, ['shared']);
  });

  it('loads shared policy and sections, with explicit CLI overrides', async (t) => {
    const directory = await fixture(t, {
      dependencies: { react: '18.2.0' }, devDependencies: { test: '^1.0.0' },
    });
    await project(directory, 'app', {
      name: 'app', dependencies: { react: '19.0.0' }, devDependencies: { test: '~1.0.0' },
    });
    await configuration(directory, { comparison: 'exact', dependencyTypes: ['devDependencies'] });
    const configured = jsonResult(run(directory, '--check', '--json'), 1, 'mismatch');
    assert.equal(configured.dependencies, null);
    assert.deepEqual(configured.mismatches, ['test']);
    const compatible = jsonResult(run(directory, '--check', '--json', '--comparison', 'compatible'), 0, 'ok');
    assert.deepEqual(compatible.compatible, ['test']);
    const prod = jsonResult(run(directory, '--check', '--json', '--only', 'prod'), 1, 'mismatch');
    assert.equal(prod.devDependencies, null);
    assert.deepEqual(prod.mismatches, ['react']);
    const disabled = jsonResult(run(directory, '--check', '--json', '--no-config'), 1, 'mismatch');
    assert.equal(disabled.comparison, 'compatible');
    assert.equal(disabled.devDependencies, null);
  });

  it('combines CLI exclusions with config exclusions before reading invalid manifests', async (t) => {
    const directory = await fixture(t);
    for (const folder of ['generated', 'legacy']) {
      await mkdir(join(directory, folder));
      await writeFile(join(directory, folder, 'package.json'), '{broken');
    }
    await configuration(directory, { exclude: ['generated/**'] });
    jsonResult(run(directory, '--check', '--json'), 2, 'error');
    const data = jsonResult(run(directory, '--check', '--json', '--exclude', 'legacy'), 0, 'ok');
    assert.deepEqual(data.projects.map((p) => p.id), ['.']);
    jsonResult(run(directory, '--check', '--json', '--no-config', '--exclude', 'legacy'), 2, 'error');
  });

  it('inherits config from a parent and keeps exclusions relative to that config', async (t) => {
    const directory = await fixture(t);
    await project(directory, 'packages/app', { name: 'app' });
    await mkdir(join(directory, 'packages/app/broken'));
    await writeFile(join(directory, 'packages/app/broken/package.json'), '{bad');
    await configuration(directory, { exclude: ['packages/app/broken'], comparison: 'exact' });
    const data = jsonResult(run(join(directory, 'packages/app'), '--check', '--json'), 0, 'ok');
    assert.equal(data.comparison, 'exact');
    assert.deepEqual(data.projects.map((p) => p.id), ['.']);
  });

  it('supports an explicit config file and additive ignored package patterns', async (t) => {
    const directory = await fixture(t, { dependencies: { '@org/one': '1.0.0', two: '1.0.0' } });
    await project(directory, 'app', { name: 'app', dependencies: { '@org/one': '2.0.0', two: '2.0.0' } });
    const configFile = join(directory, 'ci-policy.json');
    await writeFile(configFile, JSON.stringify({ ignorePackages: ['@org/*'] }));
    const configured = jsonResult(run(directory, '--check', '--json', '--config', configFile), 1, 'mismatch');
    assert.deepEqual(configured.mismatches, ['two']);
    const ignored = jsonResult(run(directory, '--check', '--json', '--config', configFile, '--ignore-package', 'two'), 0, 'ok');
    assert.deepEqual(ignored.dependencies, {});
  });

  it('honors config declared source and the CLI resolved override', async (t) => {
    const directory = await fixture(t, { dependencies: { react: '^18' } });
    await writeFile(join(directory, 'package-lock.json'), '{bad');
    await configuration(directory, { versionSource: 'declared' });
    const data = jsonResult(run(directory, '--check', '--json'), 0, 'ok');
    assert.equal(data.dependencies.react.versions['.'].source, 'package.json');
    jsonResult(run(directory, '--check', '--json', '--version-source', 'resolved'), 2, 'error');
  });

  it('depth 0 scans only the root and overrides a configured depth', async (t) => {
    const directory = await fixture(t, { dependencies: { one: '1.0.0' } });
    await project(directory, 'app', { name: 'app', dependencies: { one: '2.0.0' } });
    await configuration(directory, { maxDepth: 1 });
    jsonResult(run(directory, '--check', '--json'), 1, 'mismatch');
    const data = jsonResult(run(directory, '--check', '--json', '--depth', '0'), 0, 'ok');
    assert.equal(data.projects.length, 1);
  });

  it('serializes the same report after relocating a checkout', async (t) => {
    const outputs = [];
    for (const names of [['z', 'a'], ['a', 'z']]) {
      const directory = await fixture(t);
      for (const name of names) {
        await project(directory, name, { name: 'same', dependencies: { status: name === 'a' ? '1.0.0' : '2.0.0' } });
      }
      const result = run(directory, '--check', '--json');
      const data = jsonResult(result, 1, 'mismatch');
      assert.deepEqual(data.projects.map((p) => p.id), ['.', 'a', 'z']);
      assert.ok(!result.stdout.includes(directory));
      outputs.push(result.stdout);
    }
    assert.equal(outputs[0], outputs[1]);
  });

  it('reports a structured error instead of success when all projects are excluded', async (t) => {
    const directory = await fixture(t);
    const data = jsonResult(run(directory, '--check', '--json', '--exclude', '.'), 2, 'error');
    assert.equal(data.errors[0].code, 'NO_PROJECTS');
    assert.equal(data.dependencies, null);
  });

  it('uses exit 2 and stable JSON for invalid options and configurations', async (t) => {
    const directory = await fixture(t);
    const cases = [
      [['--unknown'], 'CLI_ERROR'], [['--depth', '-1'], 'CLI_ERROR'],
      [['--depth', '101'], 'CLI_ERROR'], [['--depth', '1.5'], 'CLI_ERROR'],
      [['--only', 'production'], 'CLI_ERROR'], [['--comparison', 'unknown'], 'CONFIG_ERROR'],
      [['--version-source', 'unknown'], 'CONFIG_ERROR'], [['--config', 'absent-config.json'], 'CONFIG_ERROR'],
      [['--config', 'absent-config.json', '--no-config'], 'CONFIG_ERROR'],
      [['--no-config', '--config', 'absent-config.json'], 'CONFIG_ERROR'],
      [['--exclude', '{'.repeat(100)], 'CONFIG_ERROR'],
      [['--declared', '--version-source', 'resolved'], 'CLI_ERROR'],
    ];
    for (const [args, code] of cases) {
      const data = jsonResult(run(directory, '--check', '--json', ...args), 2, 'error');
      assert.equal(data.errors[0].code, code, args.join(' '));
    }
    await configuration(directory, { comparisons: 'exact' });
    assert.equal(jsonResult(run(directory, '--check', '--json'), 2, 'error').errors[0].code, 'CONFIG_ERROR');
  });
});
