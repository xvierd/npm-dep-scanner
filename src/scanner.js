import { readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readPackageJson, projectName } from './utils.js';
import { readLockfile } from './lockfiles.js';
import { readWorkspacePatterns, workspaceMembers } from './workspaces.js';
import { matchPatterns, validatePatterns } from './patterns.js';

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build']);
const posixRelative = (base, path) => relative(base, path).split(sep).join('/') || '.';

/**
 * Scan real directories for package.json files. Depth 0 includes only rootDir;
 * depth 1 also includes its children. Exclusions are relative to excludeBaseDir
 * and apply to directories (including descendants) or package.json manifests.
 */
export async function scanProjects(rootDir, {
  maxDepth = 10,
  onProgress = null,
  useDeclared = false,
  exclude = [],
  excludeBaseDir = rootDir,
} = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new Error('Scan depth must be a nonnegative integer');
  const patterns = exclusionPatterns(exclude);
  const requestedRoot = resolve(rootDir);
  const requestedBase = resolve(excludeBaseDir);
  rootDir = await realpath(requestedRoot);
  const baseDir = requestedBase === requestedRoot ? rootDir : await realpath(requestedBase);
  const excluded = exclusionFilter(patterns, baseDir);
  const matches = [];
  let pending = [{ dir: rootDir, depth: 0 }];
  while (pending.length) {
    const excludedDirs = await excluded(pending.map(({ dir }) => dir));
    const next = [];
    for (const { dir, depth } of pending) {
      if (excludedDirs.has(dir)) continue;
      const entries = (await readdir(dir, { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        // Dirent methods do not follow symlinks, including package.json links.
        if (entry.name === 'package.json' && entry.isFile()) matches.push(join(dir, entry.name));
        if (depth < maxDepth && entry.isDirectory() && !entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name)) {
          next.push({ dir: join(dir, entry.name), depth: depth + 1 });
        }
      }
    }
    pending = next;
  }

  const excludedManifests = await excluded(matches);
  const projects = [];
  for (const absPath of matches) {
    if (excludedManifests.has(absPath)) continue;
    const pkg = await readPackageJson(absPath, { strict: true });
    if (!pkg) continue;
    const relPath = posixRelative(rootDir, dirname(absPath));
    projects.push({
      name: projectName(pkg, absPath),
      id: absPath,
      relativePath: relPath === '.' ? '.' : './' + relPath,
      absolutePath: absPath,
      pkg,
      lockfile: null,
    });
    if (onProgress) onProgress(projects.length);
  }
  if (projects.length === 0) return projects;

  // Find workspace configs along discovered paths and scan-root ancestors only.
  // Never traverse siblings to discover a workspace when starting in a member.
  const directories = new Set();
  for (const project of projects) {
    for (let dir = dirname(project.absolutePath); dir !== rootDir; dir = dirname(dir)) {
      directories.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  for (let dir = rootDir; ; dir = dirname(dir)) {
    directories.add(dir);
    if (dirname(dir) === dir) break;
  }
  // An excluded manifest also disables that directory's workspace config and
  // shared lock. Its non-excluded children may still be independent projects.
  const excludedConfigs = await excluded([...directories].flatMap((dir) => [dir, join(dir, 'package.json')]));
  const workspaces = [];
  for (const dir of directories) {
    if (excludedConfigs.has(dir) || excludedConfigs.has(join(dir, 'package.json'))) continue;
    const patterns = await readWorkspacePatterns(dir);
    if (patterns.length) workspaces.push({ dir, members: await workspaceMembers(dir, projects, patterns) });
  }
  workspaces.sort((a, b) => b.dir.length - a.dir.length);
  const lockfileCache = new Map();
  for (const project of projects) {
    const projectDir = dirname(project.absolutePath);
    const workspace = workspaces.find((candidate) => candidate.members.has(project.absolutePath));
    if (workspace) project.isWorkspaceMember = true;
    if (useDeclared) continue;
    project.lockfile = await readLockfile(projectDir, { pkg: project.pkg, projectPath: '.', cache: lockfileCache });
    if (!project.lockfile && workspace) {
      project.lockfile = await readLockfile(workspace.dir, {
        pkg: project.pkg,
        projectPath: posixRelative(workspace.dir, projectDir),
        cache: lockfileCache,
      });
    }
  }

  projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return projects;
}

function exclusionPatterns(patterns) {
  validatePatterns(patterns, { label: 'exclude patterns' });
  const normalized = patterns.map((pattern) => pattern.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '') || '.');
  if (normalized.some((pattern) => pattern.startsWith('!') && !pattern.startsWith('!('))) {
    throw new Error('Invalid exclude patterns: negative patterns are not supported');
  }
  return normalized;
}

function exclusionFilter(patterns, baseDir) {
  const cache = new Map();
  const ancestors = (path) => {
    const paths = [];
    for (let current = path; ; current = dirname(current)) {
      paths.push(current);
      if (current === baseDir || dirname(current) === current) break;
    }
    return paths;
  };
  return async (paths) => {
    if (patterns.length === 0 || paths.length === 0) return new Set();
    const chains = paths.map((path) => [path, ancestors(path)]);
    const unchecked = [...new Set(chains.flatMap(([, chain]) => chain))].filter((path) => !cache.has(path));
    if (unchecked.length) {
      const values = unchecked.map((path) => posixRelative(baseDir, path));
      const matches = new Set(await matchPatterns(values, patterns, { label: 'exclude patterns', dot: true }));
      for (let i = 0; i < unchecked.length; i++) cache.set(unchecked[i], matches.has(values[i]));
    }
    return new Set(chains.filter(([, chain]) => chain.some((path) => cache.get(path))).map(([path]) => path));
  };
}
