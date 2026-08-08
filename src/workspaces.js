import fg from 'fast-glob';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readPackageJson } from './utils.js';

/**
 * Detect whether `rootDir` is a workspace root (npm/yarn `workspaces` field
 * or pnpm-workspace.yaml) and mark the member projects with
 * `isWorkspaceMember: true`.
 *
 * @returns {Promise<{ isWorkspace: boolean, patterns: string[] }>}
 */
export async function markWorkspaceMembers(rootDir, projects) {
  const patterns = await readWorkspacePatterns(rootDir);
  if (patterns.length === 0) return { isWorkspace: false, patterns };

  const pkgGlobs = patterns.map((p) => p.replace(/\/+$/, '') + '/package.json');
  const matches = await fg(pkgGlobs, {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**'],
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const members = new Set(matches.map((p) => resolve(p)));
  for (const project of projects) {
    if (members.has(resolve(project.absolutePath))) {
      project.isWorkspaceMember = true;
    }
  }

  return { isWorkspace: true, patterns };
}

async function readWorkspacePatterns(rootDir) {
  // npm / yarn: "workspaces" in package.json (array or { packages: [...] })
  const pkg = await readPackageJson(join(rootDir, 'package.json'));
  if (pkg && pkg.workspaces) {
    const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
    if (Array.isArray(list) && list.length > 0) {
      return list.filter((p) => typeof p === 'string' && !p.startsWith('!'));
    }
  }

  // pnpm: pnpm-workspace.yaml with a "packages" list
  try {
    const raw = await readFile(join(rootDir, 'pnpm-workspace.yaml'), 'utf-8');
    const doc = parseYaml(raw);
    if (doc && Array.isArray(doc.packages) && doc.packages.length > 0) {
      return doc.packages.filter((p) => typeof p === 'string' && !p.startsWith('!'));
    }
  } catch {
    // no pnpm-workspace.yaml
  }

  return [];
}
