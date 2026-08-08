import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readLockfile,
  parsePackageLock,
  parseYarnLock,
  parsePnpmLock,
} from '../src/lockfiles.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

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
});
