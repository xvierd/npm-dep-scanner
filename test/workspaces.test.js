import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { markWorkspaceMembers, validateWorkspacePatterns, workspaceMembers } from '../src/workspaces.js';

async function fixture(t, filename, content) {
  const root = await mkdtemp(join(tmpdir(), 'npm-dep-scanner-workspaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, filename), content);
  return root;
}

const projectsAt = (root, paths) => paths.map((path) => ({ absolutePath: join(root, path, 'package.json') }));

describe('workspace membership', () => {
  for (const format of ['npm', 'pnpm']) {
    it(`preserves ${format} exclusions when marking known projects`, async (t) => {
      const patterns = ['packages/*', '!packages/excluded'];
      const root = await fixture(t, format === 'npm' ? 'package.json' : 'pnpm-workspace.yaml',
        format === 'npm' ? JSON.stringify({ workspaces: patterns }) : 'packages:\n  - packages/*\n  - "!packages/excluded"\n');
      const projects = projectsAt(root, ['packages/a', 'packages/excluded', 'outside']);
      const workspace = await markWorkspaceMembers(root, projects);
      assert.deepEqual(workspace, { isWorkspace: true, patterns });
      assert.deepEqual(projects.map((project) => !!project.isWorkspaceMember), [true, false, false]);
    });
  }

  it('supports braces, numeric ranges, extglobs, trailing slashes and dot-relative patterns', async () => {
    const root = '/example/repo[1]{literal}';
    const projects = projectsAt(root, ['packages/a', 'libs/b', 'services/1', 'services/2', 'apps/web', 'apps/api', 'other']);
    const patterns = ['./{packages,libs}/[ab]/', 'services/{1..2}', 'apps/@(web|api)'];
    assert.equal((await workspaceMembers(root, projects, patterns)).size, 6);
  });

  it('does not turn an exclusion-only config into a catch-all or include the root', async () => {
    const root = '/example';
    const projects = projectsAt(root, ['.', 'packages/a', '../outside']);
    assert.equal((await workspaceMembers(root, projects, ['!packages/b'])).size, 0);
    assert.deepEqual([...await workspaceMembers(root, projects, ['**'])], [join(root, 'packages/a/package.json')]);
  });

  it('distinguishes a leading negative extglob from an exclusion-only config', async () => {
    const root = '/example';
    const projects = projectsAt(root, ['a', 'excluded']);
    const members = await workspaceMembers(root, projects, ['!(excluded)']);
    assert.deepEqual([...members], [join(root, 'a/package.json')]);
  });
});

describe('workspace pattern resource limits', () => {
  it('rejects malformed and over-budget inputs before matching', () => {
    const bad = [
      ['packages/{a,b'], ['packages/(a|b'], ['packages/[abc'], ['packages/}'], ['packages/foo\\'],
      ['a'.repeat(1025)], Array.from({ length: 129 }, () => '*'), [42],
      ['{1..999999999999999999999}'], ['{1..2..0}'], ['{1..2..x}'],
      ['{1..{1000000000}}'], ['{"}"'.repeat(100)],
      ['{1..65}{1..65}'], ['{1..2048}', '{1..2049}'],
      ['{a,b}'.repeat(13)], ['{'.repeat(9) + 'a' + '}'.repeat(9)],
    ];
    for (const patterns of bad) assert.throws(() => validateWorkspacePatterns(patterns), /Invalid workspace patterns/);
    assert.doesNotThrow(() => validateWorkspacePatterns(['{1..64}{1..64}']));
    assert.doesNotThrow(() => validateWorkspacePatterns(['{a,{b,c}}', '{3..1}', '{a..z..2}', '{foo{1..3}}']));
  });

  it('rejects deep, malformed, range and cartesian attacks in a bounded child process', () => {
    const moduleUrl = new URL('../src/workspaces.js', import.meta.url).href;
    const script = `import { workspaceMembers } from ${JSON.stringify(moduleUrl)};
      try { await workspaceMembers('/repo', [{absolutePath:'/repo/packages/a/package.json'}], JSON.parse(process.argv[1])); process.exitCode = 2; }
      catch (error) { if (!error.message.startsWith('Invalid workspace patterns:')) throw error; }`;
    const attacks = [
      ['{'.repeat(500) + 'a' + '}'.repeat(500)],
      ['{'.repeat(500)],
      ['{1..1000000000}'],
      ['{a,b}'.repeat(100)],
      ['{"}"'.repeat(200)],
    ];
    for (const patterns of attacks) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(patterns)], {
        timeout: 3000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, child.stderr);
    }
  });

  it('handles regex-like patterns safely and terminates wildcard backtracking', () => {
    const moduleUrl = new URL('../src/workspaces.js', import.meta.url).href;
    const script = `import { workspaceMembers } from ${JSON.stringify(moduleUrl)};
      const projects = [{absolutePath:'/repo/packages/' + 'a'.repeat(80) + '!/package.json'}];
      const pattern = JSON.parse(process.argv[1]);
      const expectsTimeout = pattern[0].includes('*a');
      try {
        const matches = await workspaceMembers('/repo', projects, pattern);
        if (expectsTimeout || matches.size !== 0) process.exitCode = 2;
      }
      catch (error) {
        if (!expectsTimeout || !/^Invalid workspace patterns: matching exceeded 1500 ms$/.test(error.message)) throw error;
        // A fresh ordinary match must still work after the busy worker was killed.
        if ((await workspaceMembers('/repo', projects, ['packages/*'])).size !== 1) process.exitCode = 3;
      }`;
    const attacks = [
      ['packages/(a+)+$'],
      ['packages/((a)+)+'],
      ['packages/(a|aa)+'],
      ['packages/' + '*a'.repeat(24) + 'b'],
    ];
    for (const patterns of attacks) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(patterns)], {
        timeout: 6000,
        maxBuffer: 64 * 1024,
        encoding: 'utf8',
      });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, 0, `${patterns[0]}: ${child.stderr}`);
    }
  });

  for (const format of ['npm', 'pnpm']) {
    it(`validates ${format} configuration before invoking the matcher`, async (t) => {
      const root = await fixture(t, format === 'npm' ? 'package.json' : 'pnpm-workspace.yaml',
        format === 'npm' ? JSON.stringify({ workspaces: ['{1..1000000000}'] }) : 'packages:\n  - "{1..1000000000}"\n');
      await assert.rejects(markWorkspaceMembers(root, projectsAt(root, ['packages/a'])), /expansion budget/);
    });
  }
});
