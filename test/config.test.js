import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';

const DEFAULTS = {
  schemaVersion: 1,
  exclude: [],
  ignorePackages: [],
  comparison: 'compatible',
  dependencyTypes: ['dependencies'],
  versionSource: 'resolved',
  maxDepth: 10,
};

async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.git'));
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

const configFailure = (path, detail) => (error) => {
  assert.equal(error.code, 'CONFIG_ERROR');
  assert.ok(error.message.includes(path), error.message);
  if (detail) assert.match(error.message, detail);
  return true;
};

describe('validateConfig', () => {
  it('provides defaults with independent arrays and never mutates the input', () => {
    const defaults = validateConfig({});
    assert.deepEqual(defaults, DEFAULTS);
    defaults.exclude.push('changed');
    defaults.ignorePackages.push('changed');
    defaults.dependencyTypes.push('devDependencies');
    assert.deepEqual(validateConfig({}), DEFAULTS);
    const input = {
      exclude: ['generated/**'], ignorePackages: ['@types/*'], dependencyTypes: ['devDependencies'],
    };
    const config = validateConfig(input);
    config.exclude.push('changed');
    config.ignorePackages.push('changed');
    config.dependencyTypes.push('dependencies');
    assert.deepEqual(input, {
      exclude: ['generated/**'], ignorePackages: ['@types/*'], dependencyTypes: ['devDependencies'],
    });
  });

  it('normalizes all settings and treats $schema as inert optional metadata', () => {
    const input = {
      $schema: './node_modules/npm-dep-scanner/schemas/config.schema.json',
      schemaVersion: 1,
      exclude: ['generated/**', '!(packages)'],
      ignorePackages: ['@types/*', '!(react)'],
      comparison: 'exact',
      dependencyTypes: ['optionalDependencies', 'peerDependencies', 'devDependencies', 'dependencies'],
      versionSource: 'declared',
      maxDepth: 0,
    };
    const { $schema, ...expected } = input;
    assert.deepEqual(validateConfig(input), expected);
    assert.equal(validateConfig({ maxDepth: 100 }).maxDepth, 100);
    assert.deepEqual(validateConfig(Object.create(null)), DEFAULTS);
  });

  it('rejects unknown, unsafe and inherited configuration keys', () => {
    const inputs = [
      { typo: true },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
      JSON.parse('{"prototype":{"polluted":true}}'),
      Object.create({ comparison: 'exact' }),
      { [Symbol('unknown')]: true },
    ];
    for (const input of inputs) {
      assert.throws(() => validateConfig(input, { path: '/repo/settings.json' }), configFailure('/repo/settings.json'));
    }
    assert.equal(Object.prototype.polluted, undefined);
  });

  it('rejects unsupported versions, types, enums, duplicate dependency types and depth values', () => {
    const inputs = [
      null, [], false, 'config',
      { $schema: 1 }, { schemaVersion: '1' }, { schemaVersion: 2 }, { schemaVersion: undefined },
      { comparison: 'loose' }, { comparison: null }, { versionSource: 'installed' },
      { dependencyTypes: [] }, { dependencyTypes: ['prod'] }, { dependencyTypes: 'dependencies' },
      { dependencyTypes: ['dependencies', 'dependencies'] }, { dependencyTypes: new Array(1) },
      { maxDepth: -1 }, { maxDepth: 101 }, { maxDepth: 1.5 }, { maxDepth: '10' }, { maxDepth: NaN },
      { maxDepth: null }, { exclude: 'build' }, { exclude: [1] }, { ignorePackages: [null] },
    ];
    for (const input of inputs) assert.throws(() => validateConfig(input), configFailure('<configuration>'));
  });

  it('rejects unsafe glob inputs and ordinary !pattern reinclusion in both pattern fields', () => {
    const unsafe = [
      ['!packages/keep'], ['!!packages/keep'], ['./!keep'], ['././!keep'],
      [''], ['bad\npattern'], ['a'.repeat(1025)],
      Array.from({ length: 129 }, () => '*'), ['{1..1000000000}'],
      ['{'.repeat(20) + 'a' + '}'.repeat(20)], ['{a,b}'.repeat(13)], ['packages/{a,b'],
    ];
    for (const key of ['exclude', 'ignorePackages']) {
      for (const patterns of unsafe) {
        assert.throws(() => validateConfig({ [key]: patterns }), configFailure('<configuration>'));
      }
      assert.doesNotThrow(() => validateConfig({ [key]: ['!(keep)', './!(keep)', '././!(keep)', '\\!literal', '{packages,apps}/*'] }));
    }
  });
});

describe('loadConfig', () => {
  it('returns defaults and the scan root when no config exists', async (t) => {
    const root = await fixture(t);
    const nested = join(root, 'packages/a');
    await mkdir(nested, { recursive: true });
    assert.deepEqual(await loadConfig(nested), { config: DEFAULTS, path: null, baseDir: resolve(nested) });
  });

  it('loads the nearest ancestor config without merging a more distant one', async (t) => {
    const root = await fixture(t, {
      '.npm-dep-scanner.json': { comparison: 'exact', maxDepth: 30 },
      'packages/.npm-dep-scanner.json': { exclude: ['generated/**'] },
    });
    const nested = join(root, 'packages/a');
    await mkdir(nested);
    const path = await realpath(join(root, 'packages/.npm-dep-scanner.json'));
    assert.deepEqual(await loadConfig(nested), {
      config: { ...DEFAULTS, exclude: ['generated/**'] }, path, baseDir: dirname(path),
    });
  });

  for (const gitType of ['directory', 'file']) {
    it(`does not cross a .git ${gitType} boundary but loads config at that boundary`, async (t) => {
      const root = await fixture(t, { '.npm-dep-scanner.json': { comparison: 'exact' } });
      const repo = join(root, 'repo');
      const nested = join(repo, 'packages/a');
      await mkdir(nested, { recursive: true });
      if (gitType === 'directory') await mkdir(join(repo, '.git'));
      else await writeFile(join(repo, '.git'), 'gitdir: ../external-git-directory');
      const missing = await loadConfig(nested);
      assert.equal(missing.path, null);
      assert.equal(missing.config.comparison, 'compatible');
      await writeFile(join(repo, '.npm-dep-scanner.json'), JSON.stringify({ maxDepth: 4 }));
      const found = await loadConfig(nested);
      assert.equal(found.config.maxDepth, 4);
      assert.equal(found.path, await realpath(join(repo, '.npm-dep-scanner.json')));
    });
  }

  it('resolves an explicit config relative to cwd instead of the scan directory', async (t) => {
    const root = await fixture(t, {
      '.npm-dep-scanner.json': { comparison: 'compatible' },
      'settings/custom.json': { comparison: 'exact', exclude: ['fixtures/**'] },
    });
    const path = join(root, 'settings/custom.json');
    const loaded = await loadConfig(root, { configFile: relative(process.cwd(), path) });
    assert.equal(loaded.path, await realpath(path));
    assert.equal(loaded.baseDir, dirname(loaded.path));
    assert.deepEqual(loaded.config, { ...DEFAULTS, comparison: 'exact', exclude: ['fixtures/**'] });
  });

  it('returns the real config location when explicitly passed a symlink', { skip: process.platform === 'win32' }, async (t) => {
    const root = await fixture(t, { 'settings/custom.json': { maxDepth: 5 } });
    const alias = join(root, 'alias.json');
    await symlink(join(root, 'settings/custom.json'), alias);
    const loaded = await loadConfig(root, { configFile: alias });
    assert.equal(loaded.path, await realpath(alias));
    assert.equal(loaded.baseDir, dirname(loaded.path));
  });

  it('discovers a member symlink target configuration within its real repository', { skip: process.platform === 'win32' }, async (t) => {
    const root = await fixture(t, {
      '.npm-dep-scanner.json': { comparison: 'compatible' },
      'repo/.npm-dep-scanner.json': { comparison: 'exact', exclude: ['generated/**'] },
    });
    await mkdir(join(root, 'repo/.git'));
    await mkdir(join(root, 'repo/member'));
    const alias = join(root, 'member-alias');
    await symlink(join(root, 'repo/member'), alias);
    const loaded = await loadConfig(alias);
    assert.equal(loaded.config.comparison, 'exact');
    assert.equal(loaded.path, await realpath(join(root, 'repo/.npm-dep-scanner.json')));
    assert.equal(loaded.baseDir, dirname(loaded.path));

    await rm(join(root, 'repo/.npm-dep-scanner.json'));
    const defaults = await loadConfig(alias);
    assert.equal(defaults.path, null);
    assert.deepEqual(defaults.config, DEFAULTS);
    assert.equal(defaults.baseDir, resolve(alias));
  });

  it('reports missing explicit files, invalid JSON, invalid settings and unreadable file paths', async (t) => {
    const root = await fixture(t, {
      'invalid.json': '{"comparison":"exact",}',
      'unknown.json': { comaprison: 'exact' },
      'unsafe.json': '{"__proto__":{"polluted":true}}',
    });
    for (const file of ['missing.json', 'invalid.json', 'unknown.json', 'unsafe.json']) {
      const path = join(root, file);
      await assert.rejects(loadConfig(root, { configFile: path }), configFailure(path));
    }
    await assert.rejects(loadConfig(root, { configFile: root }), configFailure(root));
    await writeFile(join(root, '.npm-dep-scanner.json'), '{broken');
    await assert.rejects(loadConfig(root), configFailure(join(root, '.npm-dep-scanner.json')));
  });

  it('skips config reads when disabled and rejects conflicting or malformed loader options', async (t) => {
    const root = await fixture(t, { '.npm-dep-scanner.json': '{broken' });
    assert.deepEqual(await loadConfig(root, { enabled: false }), { config: DEFAULTS, path: null, baseDir: resolve(root) });
    for (const options of [
      { configFile: 'explicit.json', enabled: false },
      { configFile: '' }, { configFile: null }, { enabled: 'false' },
    ]) {
      await assert.rejects(loadConfig(root, options), configFailure(root));
    }
  });

  it('reports a dangling config symlink instead of silently using defaults', { skip: process.platform === 'win32' }, async (t) => {
    const root = await fixture(t);
    const path = join(root, '.npm-dep-scanner.json');
    await symlink(join(root, 'missing-shared.json'), path);
    await assert.rejects(loadConfig(root), configFailure(path, /ENOENT/));
  });
});

describe('published configuration schema', () => {
  it('documents the accepted settings and rejects unsupported reinclusion syntax', async () => {
    const schema = JSON.parse(await readFile(new URL('../schemas/config.schema.json', import.meta.url), 'utf-8'));
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), ['$schema', ...Object.keys(DEFAULTS)].sort());
    assert.equal(schema.properties.schemaVersion.const, 1);
    const pattern = new RegExp(schema.$defs.patterns.items.pattern);
    for (const value of ['packages/*', '!(keep)', './!(keep)', '././!(keep)', '\\!literal']) assert.equal(pattern.test(value), true);
    for (const value of ['!packages/keep', '!!packages/keep', './!keep', '././!keep', 'bad\npattern', '']) assert.equal(pattern.test(value), false);
  });
});
