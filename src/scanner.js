import fg from 'fast-glob';
import { dirname, relative } from 'node:path';
import { readPackageJson, projectName } from './utils.js';
import { readLockfile } from './lockfiles.js';

const IGNORE_DIRS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.*/**'];

/**
 * Scan `rootDir` for package.json files up to `maxDepth` levels deep.
 * For each project, also reads its lockfile (package-lock.json,
 * pnpm-lock.yaml or yarn.lock) when present.
 *
 * @param {string} rootDir
 * @param {Object} opts
 * @param {number} opts.maxDepth
 * @param {Function} [opts.onProgress] — called with the number of projects read so far
 * @returns {Promise<Array>} — { name, relativePath, absolutePath, pkg, lockfile }
 */
export async function scanProjects(rootDir, { maxDepth = 10, onProgress = null } = {}) {
  const pattern = '**/package.json';
  const matches = await fg(pattern, {
    cwd: rootDir,
    absolute: true,
    ignore: IGNORE_DIRS,
    deep: maxDepth,
    onlyFiles: true,
    followSymbolicLinks: false,
  });

  const projects = [];

  for (const absPath of matches) {
    const pkg = await readPackageJson(absPath);
    if (!pkg) continue; // skip invalid JSON

    const name = projectName(pkg, absPath);
    const relPath = './' + relative(rootDir, absPath).replace(/\/package\.json$/, '');
    const lockfile = await readLockfile(dirname(absPath));

    projects.push({
      name,
      relativePath: relPath === './' ? '.' : relPath,
      absolutePath: absPath,
      pkg,
      lockfile,
    });

    if (onProgress) onProgress(projects.length);
  }

  // Sort by name for consistent ordering
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return projects;
}
