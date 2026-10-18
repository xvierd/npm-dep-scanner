import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readPackageJson } from './utils.js';

import { matchPatterns, validatePatterns } from './patterns.js';

export function validateWorkspacePatterns(patterns) {
  return validatePatterns(patterns, { label: 'workspace patterns' });
}

/** Read npm/yarn or pnpm workspace patterns, preserving exclusions. */
export async function readWorkspacePatterns(rootDir) {
  const pkg = await readPackageJson(join(rootDir, 'package.json'));
  if (pkg && pkg.workspaces) {
    const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages;
    if (Array.isArray(list) && list.length > 0) return validateWorkspacePatterns(list);
  }

  let raw;
  try {
    raw = await readFile(join(rootDir, 'pnpm-workspace.yaml'), 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const doc = parseYaml(raw);
  if (doc && Array.isArray(doc.packages)) return validateWorkspacePatterns(doc.packages);
  return [];
}

/** Match only discovered manifests; never traverse directories outside the scan. */
export async function workspaceMembers(rootDir, projects, patterns) {
  validateWorkspacePatterns(patterns);
  // A leading negative extglob is an inclusion pattern, unlike !path exclusions.
  if (!patterns.some((p) => !p.startsWith('!') || p.startsWith('!('))) return new Set();
  const candidates = projects.map((project) => ({
    path: resolve(project.absolutePath),
    relative: relative(rootDir, dirname(project.absolutePath)).split(sep).join('/'),
  })).filter((candidate) => !candidate.relative.startsWith('../') && candidate.relative !== '..' && candidate.relative !== '');
  if (candidates.length === 0) return new Set();
  const globs = patterns.map((p) => p.replace(/\/+$/, '').replace(/^(!?)\.\//, '$1'));
  const matches = new Set(await matchPatterns(candidates.map((candidate) => candidate.relative), globs, { label: 'workspace patterns' }));
  return new Set(candidates.filter((candidate) => matches.has(candidate.relative)).map((candidate) => candidate.path));
}

/** Mark members without discarding membership in nested workspaces. */
export async function markWorkspaceMembers(rootDir, projects) {
  const patterns = await readWorkspacePatterns(rootDir);
  const members = await workspaceMembers(rootDir, projects, patterns);
  for (const project of projects) {
    if (members.has(resolve(project.absolutePath))) project.isWorkspaceMember = true;
  }
  return { isWorkspace: patterns.length > 0, patterns };
}
