import fg from 'fast-glob';
import { relative } from 'node:path';
import { readPackageJson, projectName } from './utils.js';

const IGNORE_DIRS = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.*/**'];

/**
 * Scan `rootDir` for package.json files up to `maxDepth` levels deep.
 * Returns an array of { name, relativePath, absolutePath, pkg }.
 */
export async function scanProjects(rootDir, { maxDepth = 3 } = {}) {
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

    projects.push({
      name,
      relativePath: relPath === './' ? '.' : relPath,
      absolutePath: absPath,
      pkg,
    });
  }

  // Sort by name for consistent ordering
  projects.sort((a, b) => a.name.localeCompare(b.name));

  return projects;
}
