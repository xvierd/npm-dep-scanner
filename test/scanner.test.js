import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { scanProjects } from '../src/scanner.js';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return root;
}

const pkg = (name, version = '*') => ({ name, dependencies: { foo: version } });
const locked = (project) => project.lockfile?.resolveVersion('foo', project.pkg.dependencies.foo, 'dependencies');

function npmLock(version, extra = {}) {
  return { lockfileVersion: 3, packages: { 'node_modules/foo': { version }, ...extra } };
}

describe('scanProjects', () => {
  it('counts depth from the scan root and retains default ignored directories', async (t) => {
    const root = await fixture(t, {
      'package.json': pkg('root'),
      'child/package.json': pkg('child'),
      'child/grandchild/package.json': pkg('grandchild'),
      'node_modules/broken/package.json': '{broken',
      '.hidden/package.json': '{broken',
      'dist/package.json': '{broken',
      'build/package.json': '{broken',
    });
    assert.deepEqual((await scanProjects(root, { maxDepth: 0 })).map((project) => project.name), ['root']);
    assert.deepEqual((await scanProjects(root, { maxDepth: 1 })).map((project) => project.name), ['child', 'root']);
    assert.deepEqual((await scanProjects(root, { maxDepth: 2 })).map((project) => project.name), ['child', 'grandchild', 'root']);
  });

  it('does not follow directory or package manifest symlinks', async (t) => {
    const root = await fixture(t, { 'package.json': pkg('root'), 'linked-manifest/placeholder': '' });
    await symlink(root, join(root, 'cycle'), 'dir');
    await symlink(join(root, 'package.json'), join(root, 'linked-manifest/package.json'), 'file');
    assert.deepEqual((await scanProjects(root)).map((project) => project.name), ['root']);
  });

  it('prunes excluded directories before reading their manifests, configs or locks', async (t) => {
    const root = await fixture(t, {
      'package.json': pkg('root'),
      'keep/package.json': pkg('keep'),
      'vendor/package.json': '{broken',
      'vendor/pnpm-workspace.yaml': 'packages: [',
      'vendor/child/package.json': '{broken',
      'examples/a/package.json': '{broken',
      'examples/a/package-lock.json': '{broken',
    });
    const projects = await scanProjects(root, { exclude: ['./vendor/', 'examples/**'] });
    assert.deepEqual(projects.map((project) => project.name), ['keep', 'root']);
  });

  it('omits excluded manifests and their workspace metadata while keeping independent children', async (t) => {
    const root = await fixture(t, {
      'package.json': '{broken',
      'pnpm-workspace.yaml': 'packages: [',
      'package-lock.json': '{broken',
      'keep/package.json': pkg('keep'),
    });
    const projects = await scanProjects(root, { exclude: ['package.json'] });
    assert.deepEqual(projects.map((project) => project.name), ['keep']);
    assert.equal(projects[0].isWorkspaceMember, undefined);
    assert.equal(projects[0].lockfile, null);
  });

  it('interprets exclusions from their config base when scanning inside a repo', async (t) => {
    const root = await fixture(t, {
      'repo/keep/package.json': pkg('keep'),
      'repo/skip/package.json': '{broken',
    });
    const options = { exclude: ['repo/skip'], excludeBaseDir: root };
    assert.deepEqual((await scanProjects(join(root, 'repo'), options)).map((project) => project.name), ['keep']);
    assert.deepEqual(await scanProjects(join(root, 'repo/skip'), options), []);
    assert.deepEqual(await scanProjects(root, { exclude: ['.'] }), []);
  });

  it('rejects unsafe or negative exclude patterns before accessing the filesystem', async () => {
    for (const pattern of ['!keep', './!keep', '././!keep']) {
      await assert.rejects(scanProjects('/nonexistent-scan-root', { exclude: [pattern] }), /negative patterns/);
    }
    await assert.rejects(scanProjects('/nonexistent-scan-root', { exclude: ['{1..99999999}'] }), /expansion budget/);
  });

  it('allows an escaped literal exclamation mark in an excluded directory name', async (t) => {
    const root = await fixture(t, {
      'keep/package.json': pkg('keep'),
      '!literal/package.json': '{broken',
    });
    for (const pattern of ['\\!literal', '././\\!literal']) {
      const projects = await scanProjects(root, { exclude: [pattern] });
      assert.deepEqual(projects.map((project) => project.name), ['keep']);
    }
  });

  it('applies canonical config paths when the scan root uses an alias', async (t) => {
    const root = await fixture(t, {
      'repo/keep/package.json': pkg('keep'),
      'repo/skip/package.json': '{broken',
    });
    await symlink(join(root, 'repo'), join(root, 'alias'), 'dir');
    const projects = await scanProjects(join(root, 'alias'), {
      exclude: ['skip'],
      excludeBaseDir: await realpath(join(root, 'repo')),
    });
    assert.deepEqual(projects.map((project) => project.name), ['keep']);
  });

  it('ignores malformed locks in declared mode while retaining workspace membership', async (t) => {
    const root = await fixture(t, {
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'package-lock.json': '{broken',
      'packages/a/package.json': pkg('a'),
    });
    await assert.rejects(scanProjects(root), /package-lock\.json/);
    const projects = await scanProjects(root, { useDeclared: true });
    assert.ok(projects.every((project) => project.lockfile === null));
    assert.equal(projects.find((project) => project.name === 'a').isWorkspaceMember, true);
  });

  it('reports a malformed manifest instead of silently omitting a project', async (t) => {
    const root = await fixture(t, {
      'package.json': pkg('good'),
      'broken/package.json': '{"name":"broken",}',
    });
    await assert.rejects(scanProjects(root), /broken.*package\.json/);
  });

  it('uses stable path identities for duplicate names and displays the root as a directory', async (t) => {
    const root = await fixture(t, {
      'package.json': pkg('same'),
      'child/package.json': pkg('same'),
      'node_modules/hidden/package.json': pkg('ignored'),
      'dist/package.json': pkg('ignored'),
    });
    const projects = await scanProjects(root);
    assert.equal(projects.length, 2);
    assert.deepEqual(new Set(projects.map((project) => project.relativePath)), new Set(['.', './child']));
    assert.equal(new Set(projects.map((project) => project.id)).size, 2);
    for (const project of projects) assert.equal(project.id, resolve(project.absolutePath));
  });

  it('resolves shared npm locks in member context and honors exclusions and local locks', async (t) => {
    const root = await fixture(t, {
      'package.json': { name: 'root', workspaces: ['packages/*', '!packages/excluded'] },
      'package-lock.json': npmLock('1.0.0', { 'packages/b/node_modules/foo': { version: '2.0.0' } }),
      'packages/a/package.json': pkg('a'),
      'packages/b/package.json': pkg('b'),
      'packages/local/package.json': pkg('local'),
      'packages/local/package-lock.json': npmLock('3.0.0'),
      'packages/excluded/package.json': pkg('excluded'),
    });
    const projects = new Map((await scanProjects(root)).map((project) => [project.name, project]));
    assert.equal(locked(projects.get('a')), '1.0.0');
    assert.equal(locked(projects.get('b')), '2.0.0');
    assert.equal(locked(projects.get('local')), '3.0.0');
    assert.equal(projects.get('excluded').lockfile, null);
    assert.equal(projects.get('excluded').isWorkspaceMember, undefined);
    assert.equal(projects.get('a').isWorkspaceMember, true);
  });

  it('can start inside a member without discovering or reading sibling projects', async (t) => {
    const root = await fixture(t, {
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'package-lock.json': npmLock('1.0.0', { 'packages/a/node_modules/foo': { version: '2.0.0' } }),
      'packages/a/package.json': pkg('a'),
      'packages/b/package.json': { name: 'b', workspaces: ['{1..999999999}'] },
    });
    const projects = await scanProjects(join(root, 'packages/a'));
    assert.equal(projects.length, 1);
    assert.equal(projects[0].relativePath, '.');
    assert.equal(locked(projects[0]), '2.0.0');
    assert.equal(projects[0].isWorkspaceMember, true);
  });

  it('finds separate monorepos and pnpm roots without a package.json under a collection folder', async (t) => {
    const root = await fixture(t, {
      'repo-one/pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'repo-one/pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  packages/a:\n    dependencies:\n      foo:\n        specifier: '*'\n        version: 1.0.0\n",
      'repo-one/packages/a/package.json': pkg('a'),
      'repo-two/package.json': { name: 'root-two', workspaces: ['packages/*'] },
      'repo-two/package-lock.json': npmLock('2.0.0'),
      'repo-two/packages/b/package.json': pkg('b'),
    });
    const projects = new Map((await scanProjects(root)).map((project) => [project.name, project]));
    assert.equal(locked(projects.get('a')), '1.0.0');
    assert.equal(locked(projects.get('b')), '2.0.0');
    assert.equal(projects.get('a').isWorkspaceMember, true);
  });

  it('uses the nearest matching workspace and treats metacharacters in root paths literally', async (t) => {
    const root = await fixture(t, {
      'repo[1]{x}/package.json': { name: 'outer', workspaces: ['packages/**'] },
      'repo[1]{x}/package-lock.json': npmLock('1.0.0'),
      'repo[1]{x}/packages/nested/package.json': { name: 'nested', workspaces: ['members/*'] },
      'repo[1]{x}/packages/nested/package-lock.json': npmLock('2.0.0'),
      'repo[1]{x}/packages/nested/members/a/package.json': pkg('a'),
    });
    const projects = await scanProjects(join(root, 'repo[1]{x}'));
    assert.equal(locked(projects.find((project) => project.name === 'a')), '2.0.0');
  });

  it('resolves workspace Yarn entries by the member declared range', async (t) => {
    const root = await fixture(t, {
      'package.json': { name: 'root', workspaces: ['packages/*'] },
      'yarn.lock': 'foo@^1.0.0:\n  version "1.5.0"\n\nfoo@^2.0.0:\n  version "2.5.0"\n',
      'packages/a/package.json': pkg('a', '^1.0.0'),
      'packages/b/package.json': pkg('b', '^2.0.0'),
    });
    const projects = new Map((await scanProjects(root)).map((project) => [project.name, project]));
    assert.equal(locked(projects.get('a')), '1.5.0');
    assert.equal(locked(projects.get('b')), '2.5.0');
  });
});
