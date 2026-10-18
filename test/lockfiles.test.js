import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLockfile,
  parsePackageLock,
  parseYarnLock,
  parsePnpmLock,
} from '../src/lockfiles.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function temporaryLockfile(t, file, raw, options) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, file), raw);
  return readLockfile(dir, options);
}

describe('parsePackageLock', () => {
  it('reads lockfileVersion 2/3 via "packages"', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'x' },
        'node_modules/axios': { version: '1.7.2' },
        'node_modules/@scope/pkg': { version: '2.0.1' },
        'node_modules/axios/node_modules/debug': { version: '4.3.4' },
      },
    });
    const v = parsePackageLock(raw);
    assert.equal(v.get('axios'), '1.7.2');
    assert.equal(v.get('@scope/pkg'), '2.0.1');
    assert.equal(v.get('debug'), '4.3.4');
  });

  it('top-level entries win over nested duplicates', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/debug': { version: '4.0.0' },
        'node_modules/axios/node_modules/debug': { version: '4.3.4' },
      },
    });
    assert.equal(parsePackageLock(raw).get('debug'), '4.0.0');
  });

  it('reads lockfileVersion 1 via nested "dependencies"', () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        axios: {
          version: '1.6.0',
          dependencies: { debug: { version: '4.1.1' } },
        },
      },
    });
    const v = parsePackageLock(raw);
    assert.equal(v.get('axios'), '1.6.0');
    assert.equal(v.get('debug'), '4.1.1');
  });

  it('prefers root dependencies over earlier nested duplicates in v1', () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: { version: '1.0.0', dependencies: { lodash: { version: '3.10.1' } } },
        lodash: { version: '4.17.21' },
      },
    });
    assert.equal(parsePackageLock(raw).get('lodash'), '4.17.21');
    assert.equal(parsePackageLock(raw, { pkg: { dependencies: { lodash: '^4.17.0' } } }).get('lodash'), '4.17.21');
  });

  it('does not borrow a transitive v1 version for a missing direct dependency', () => {
    const raw = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { a: { version: '1.0.0', dependencies: { lodash: { version: '3.10.1' } } } },
    });
    const versions = parsePackageLock(raw, { pkg: { dependencies: { lodash: '^4.17.0' } } });
    assert.equal(versions.has('lodash'), false);
  });

  for (const lockfileVersion of [2, 3]) {
    it(`resolves workspace overrides and hoisted dependencies in npm v${lockfileVersion}`, () => {
      const raw = JSON.stringify({
        lockfileVersion,
        packages: {
          '': {},
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/@scope/pkg': { version: '1.0.0' },
          'packages/node_modules/shared': { version: '2.0.0' },
          'packages/a/node_modules/lodash': { version: '3.10.1' },
          'packages/b/node_modules/other': { version: '9.0.0' },
        },
      });
      const pkg = { dependencies: { lodash: '*', '@scope/pkg': '*', shared: '*', other: '*' } };
      const a = parsePackageLock(raw, { pkg, projectPath: 'packages/a' });
      const b = parsePackageLock(raw, { pkg, projectPath: 'packages/b' });
      assert.equal(a.get('lodash'), '3.10.1');
      assert.equal(b.get('lodash'), '4.17.21');
      assert.equal(a.get('@scope/pkg'), '1.0.0');
      assert.equal(a.get('shared'), '2.0.0');
      assert.equal(a.has('other'), false);
      assert.equal(b.get('other'), '9.0.0');
    });
  }

  for (const projectPath of ['.', 'packages/a']) {
    it(`does not reuse stale npm declarations for ${projectPath}`, () => {
      const packagePath = projectPath === '.' ? '' : projectPath;
      const raw = JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [packagePath]: { dependencies: { foo: '^1.0.0' }, devDependencies: { tool: '^1.0.0' } },
          'node_modules/foo': { version: '1.2.3' },
          'node_modules/tool': { version: '1.2.3' },
        },
      });
      const pkg = { dependencies: { foo: '^2.0.0' }, devDependencies: { tool: '^2.0.0' } };
      const versions = parsePackageLock(raw, { pkg, projectPath });
      assert.equal(versions.has('foo'), false);
      assert.equal(versions.has('tool'), false);
    });

    it(`keeps npm overrides when the stored declaration matches for ${projectPath}`, () => {
      const packagePath = projectPath === '.' ? '' : projectPath;
      const raw = JSON.stringify({
        lockfileVersion: 3,
        packages: {
          [packagePath]: { dependencies: { foo: '^1.0.0' } },
          'node_modules/foo': { version: '2.0.0' },
        },
      });
      const pkg = { dependencies: { foo: '^1.0.0' } };
      assert.equal(parsePackageLock(raw, { pkg, projectPath }).get('foo'), '2.0.0');
    });
  }

  it('resolves linked npm workspace packages through their package entry', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/shared': { resolved: 'packages/shared', link: true },
        'packages/shared': { version: '2.3.4' },
      },
    });
    const versions = parsePackageLock(raw, { pkg: { dependencies: { shared: '*' } }, projectPath: 'packages/a' });
    assert.equal(versions.get('shared'), '2.3.4');
  });

  it('does not bypass an unresolved local npm entry to use a hoisted copy', () => {
    const raw = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/shared': { version: '1.0.0' },
        'packages/a/node_modules/shared': { resolved: 'packages/missing', link: true },
      },
    });
    const versions = parsePackageLock(raw, { pkg: { dependencies: { shared: '*' } }, projectPath: 'packages/a' });
    assert.equal(versions.has('shared'), false);
  });
});

describe('parseYarnLock', () => {
  it('parses yarn classic (v1)', () => {
    const raw = `# yarn lockfile v1

axios@^1.6.0:
  version "1.6.8"
  resolved "https://registry.yarnpkg.com/axios/-/axios-1.6.8.tgz"

"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.24.0"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.24.0.tgz"
`;
    const v = parseYarnLock(raw);
    assert.equal(v.get('axios'), '1.6.8');
    assert.equal(v.get('@babel/core'), '7.24.0');
  });

  it('parses yarn berry (v2+) as YAML', () => {
    const raw = `__metadata:
  version: 6
  cacheKey: 8

"lodash@npm:^4.17.21":
  version: 4.17.21
  resolution: "lodash@npm:4.17.21"

"@scope/pkg@npm:^1.0.0, @scope/pkg@npm:^1.1.0":
  version: 1.1.5
  resolution: "@scope/pkg@npm:1.1.5"
`;
    const v = parseYarnLock(raw);
    assert.equal(v.get('lodash'), '4.17.21');
    assert.equal(v.get('@scope/pkg'), '1.1.5');
  });

  for (const [format, raw] of [
    ['classic', 'lodash@^3.10.1:\n  version "3.10.1"\n\nlodash@^4.17.0:\n  version "4.17.21"\n'],
    ['berry', '__metadata:\n  version: 6\n"lodash@npm:^3.10.1":\n  version: 3.10.1\n"lodash@npm:^4.17.0":\n  version: 4.17.21\n'],
  ]) {
    it(`selects the exact declared descriptor for Yarn ${format}`, () => {
      assert.equal(parseYarnLock(raw, { pkg: { dependencies: { lodash: '^4.17.0' } } }).get('lodash'), '4.17.21');
      assert.equal(parseYarnLock(raw, { pkg: { dependencies: { lodash: '^3.10.1' } } }).get('lodash'), '3.10.1');
      assert.equal(parseYarnLock(raw).has('lodash'), false);
    });

    it(`does not guess a Yarn ${format} resolution from an intersecting range`, () => {
      const versions = parseYarnLock(raw, { pkg: { dependencies: { lodash: '^4.17.1' } } });
      assert.equal(versions.has('lodash'), false);
    });
  }

  it('resolves grouped scoped descriptors and explicit npm aliases in Berry', () => {
    const raw = `__metadata:
  version: 6
"@scope/pkg@npm:^1.0.0, @scope/pkg@npm:^1.1.0":
  version: 1.1.5
"alias@npm:real-package@^2.0.0":
  version: 2.3.0
`;
    const versions = parseYarnLock(raw, { pkg: { dependencies: { '@scope/pkg': '^1.1.0', alias: 'npm:real-package@^2.0.0' } } });
    assert.equal(versions.get('@scope/pkg'), '1.1.5');
    assert.equal(versions.get('alias'), '2.3.0');
  });

  it('does not mistake a nested dependency named version for a classic version field', () => {
    const raw = 'a@^1.0.0:\n  version "1.2.3"\n  dependencies:\n    version "^9.0.0"\n';
    assert.equal(parseYarnLock(raw, { pkg: { dependencies: { a: '^1.0.0' } } }).get('a'), '1.2.3');
  });

  it('leaves conflicting duplicate Yarn descriptors unresolved', () => {
    const raw = 'a@^1.0.0:\n  version "1.2.3"\n\na@^1.0.0:\n  version "1.2.4"\n';
    assert.equal(parseYarnLock(raw, { pkg: { dependencies: { a: '^1.0.0' } } }).has('a'), false);
  });
});

describe('parsePnpmLock', () => {
  it('reads the root importer (v9)', () => {
    const raw = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      axios:
        specifier: ^1.6.0
        version: 1.7.4
      react-dom:
        specifier: ^18.2.0
        version: 18.3.1(react@18.3.1)
`;
    const v = parsePnpmLock(raw);
    assert.equal(v.get('axios'), '1.7.4');
    assert.equal(v.get('react-dom'), '18.3.1'); // peer suffix stripped
  });

  it('falls back to package index keys (v5/v6 style)', () => {
    const raw = `lockfileVersion: '6.0'
packages:
  /axios@1.7.4:
    resolution: {integrity: sha512-x==}
  /@scope/pkg@2.0.0:
    resolution: {integrity: sha512-y==}
`;
    const v = parsePnpmLock(raw);
    assert.equal(v.get('axios'), '1.7.4');
    assert.equal(v.get('@scope/pkg'), '2.0.0');
  });

  it('uses v5 root dependency references before transitive package entries', () => {
    const raw = `lockfileVersion: 5.4
specifiers:
  lodash: ^4.17.0
  react-dom: ^18.0.0
dependencies:
  lodash: 4.17.21
  react-dom: 18.2.0_react@18.2.0
packages:
  /lodash/3.10.1: {}
  /lodash/4.17.21: {}
`;
    const versions = parsePnpmLock(raw, { pkg: { dependencies: { lodash: '^4.17.0', 'react-dom': '^18.0.0' } } });
    assert.equal(versions.get('lodash'), '4.17.21');
    assert.equal(versions.get('react-dom'), '18.2.0');
    assert.equal(parsePnpmLock(raw).get('lodash'), '4.17.21');
  });

  it('uses v6 root dependency objects and strips peer suffixes', () => {
    const raw = `lockfileVersion: '6.0'
dependencies:
  lodash:
    specifier: ^4.17.0
    version: 4.17.21
  react-dom:
    specifier: ^18.0.0
    version: 18.2.0(react@18.2.0)
packages:
  /lodash@3.10.1: {}
  /lodash@4.17.21: {}
`;
    const versions = parsePnpmLock(raw, { pkg: { dependencies: { lodash: '^4.17.0', 'react-dom': '^18.0.0' } } });
    assert.equal(versions.get('lodash'), '4.17.21');
    assert.equal(versions.get('react-dom'), '18.2.0');
  });

  it('parses v5/v6/v9 package keys containing peers and scoped names', () => {
    for (const key of ['/react-dom/18.2.0_react@18.2.0', '/react-dom@18.2.0(react@18.2.0)', 'react-dom@18.2.0(react@18.2.0)']) {
      assert.equal(parsePnpmLock(`packages:\n  '${key}': {}\n`).get('react-dom'), '18.2.0');
    }
    for (const key of ['/@scope/pkg/2.0.0_react@18.2.0', '/@scope/pkg@2.0.0(react@18.2.0)', '@scope/pkg@2.0.0(react@18.2.0)']) {
      assert.equal(parsePnpmLock(`packages:\n  '${key}': {}\n`).get('@scope/pkg'), '2.0.0');
    }
  });

  it('uses the requested v9 workspace importer instead of the root or package index', () => {
    const raw = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      lodash: {specifier: ^4.17.0, version: 4.17.19}
  packages/a:
    dependencies:
      lodash: {specifier: ^4.17.0, version: 4.17.20}
  packages/b:
    dependencies:
      lodash: {specifier: ^4.17.0, version: 4.17.21}
packages:
  lodash@3.10.1: {}
`;
    const pkg = { dependencies: { lodash: '^4.17.0' } };
    assert.equal(parsePnpmLock(raw, { pkg }).get('lodash'), '4.17.19');
    assert.equal(parsePnpmLock(raw, { pkg, projectPath: 'packages/a' }).get('lodash'), '4.17.20');
    assert.equal(parsePnpmLock(raw, { pkg, projectPath: 'packages/b' }).get('lodash'), '4.17.21');
    assert.equal(parsePnpmLock(raw, { pkg, projectPath: 'packages/missing' }).has('lodash'), false);
  });

  it('does not use stale specifiers, local links, or index-only guesses as installed versions', () => {
    const raw = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      lodash: {specifier: ^3.0.0, version: 3.10.1}
      shared: {specifier: 'workspace:*', version: 'link:../shared'}
packages:
  missing@1.0.0: {}
`;
    const pkg = { dependencies: { lodash: '^4.17.0', shared: 'workspace:*', missing: '^1.0.0' } };
    assert.equal(parsePnpmLock(raw, { pkg }).size, 0);
  });

  it('leaves ambiguous index-only resolutions out of the map', () => {
    const raw = 'packages:\n  lodash@3.10.1: {}\n  lodash@4.17.21: {}\n';
    assert.equal(parsePnpmLock(raw).has('lodash'), false);
  });
});

describe('readLockfile', () => {
  it('detects package-lock.json', async () => {
    const lf = await readLockfile(join(fixtures, 'project-lock-npm'));
    assert.equal(lf.type, 'package-lock.json');
    assert.equal(lf.versions.get('axios'), '1.7.2');
  });

  it('detects yarn.lock', async () => {
    const lf = await readLockfile(join(fixtures, 'project-lock-yarn'));
    assert.equal(lf.type, 'yarn.lock');
    assert.equal(lf.versions.get('axios'), '1.6.8');
  });

  it('detects pnpm-lock.yaml', async () => {
    const lf = await readLockfile(join(fixtures, 'project-lock-pnpm'));
    assert.equal(lf.type, 'pnpm-lock.yaml');
    assert.equal(lf.versions.get('axios'), '1.7.4');
    assert.equal(lf.versions.get('zod'), '3.23.8');
  });

  it('returns null when no lockfile exists', async () => {
    const lf = await readLockfile(join(fixtures, 'project-a'));
    assert.equal(lf, null);
  });

  it('exposes a resolver with package context, even when no declaration resolves', async (t) => {
    const raw = 'lodash@^3.0.0:\n  version "3.10.1"\n';
    const lock = await temporaryLockfile(t, 'yarn.lock', raw, { pkg: { dependencies: { lodash: '^4.0.0' } } });
    assert.equal(lock.type, 'yarn.lock');
    assert.equal(lock.versions.size, 0);
    assert.equal(lock.resolveVersion('lodash', '^4.0.0', 'dependencies'), undefined);
    assert.equal(lock.resolveVersion('lodash', '^3.0.0', 'dependencies'), '3.10.1');
  });

  it('resolves dependency fields separately for pnpm', async (t) => {
    const raw = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      example: {specifier: ^1.0.0, version: 1.2.0}
    devDependencies:
      example: {specifier: ^2.0.0, version: 2.3.0}
`;
    const pkg = { dependencies: { example: '^1.0.0' }, devDependencies: { example: '^2.0.0' } };
    const lock = await temporaryLockfile(t, 'pnpm-lock.yaml', raw, { pkg });
    assert.equal(lock.resolveVersion('example', '^1.0.0', 'dependencies'), '1.2.0');
    assert.equal(lock.resolveVersion('example', '^2.0.0', 'devDependencies'), '2.3.0');
    assert.equal(lock.versions.has('example'), false);
  });

  for (const [file, raw] of [
    ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/react': { version: '19.0.0' } } })],
    ['pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      react: {specifier: ^19.0.0, version: 19.0.0}\n"],
    ['yarn.lock', 'react@^18.0.0:\n  version "18.3.1"\n\nreact@^19.0.0:\n  version "19.0.0"\n'],
  ]) {
    it(`preserves the peer contract when ${file} resolves a development dependency`, async (t) => {
      const pkg = { peerDependencies: { react: '^18.0.0' }, devDependencies: { react: '^19.0.0' } };
      const lock = await temporaryLockfile(t, file, raw, { pkg });
      assert.equal(lock.resolveVersion('react', '^18.0.0', 'peerDependencies'), undefined);
      assert.equal(lock.resolveVersion('react', '^19.0.0', 'devDependencies'), '19.0.0');
    });
  }

  it('reports a malformed existing lockfile instead of silently changing package managers', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-lock-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'package-lock.json'), '{"packages":');
    await writeFile(join(dir, 'yarn.lock'), 'a@^1.0.0:\n  version "1.2.3"\n');
    await assert.rejects(readLockfile(dir, { pkg: { dependencies: { a: '^1.0.0' } } }), (error) => {
      assert.match(error.message, /Cannot parse lockfile/);
      assert.ok(error.message.includes(join(dir, 'package-lock.json')));
      return true;
    });
  });

  it('reports unreadable existing lockfile paths', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-lock-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await mkdir(join(dir, 'package-lock.json'));
    await assert.rejects(readLockfile(dir, { pkg: {} }), (error) => {
      assert.match(error.message, /Cannot read lockfile/);
      assert.ok(error.message.includes(join(dir, 'package-lock.json')));
      return true;
    });
  });

  it('keeps a valid empty lockfile as the resolution source for its project', async (t) => {
    const lock = await temporaryLockfile(t, 'package-lock.json', '{"lockfileVersion":3,"packages":{}}', { pkg: {} });
    assert.equal(lock.type, 'package-lock.json');
    assert.equal(lock.versions.size, 0);
    assert.equal(lock.resolveVersion('missing', '*', 'dependencies'), undefined);
  });

  it('shares cached lock contents within a scan and rereads them with a new scan cache', async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-lock-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'yarn.lock');
    const pkg = { dependencies: { a: '^1.0.0' } };
    const cache = new Map();
    await writeFile(path, 'a@^1.0.0:\n  version "1.2.3"\n');
    const first = await readLockfile(dir, { pkg, cache });
    await writeFile(path, 'a@^1.0.0:\n  version "1.2.4"\n');
    const sameScan = await readLockfile(dir, { pkg, cache });
    const nextScan = await readLockfile(dir, { pkg, cache: new Map() });
    assert.equal(first.resolveVersion('a', '^1.0.0', 'dependencies'), '1.2.3');
    assert.equal(sameScan.resolveVersion('a', '^1.0.0', 'dependencies'), '1.2.3');
    assert.equal(nextScan.resolveVersion('a', '^1.0.0', 'dependencies'), '1.2.4');
  });
});
