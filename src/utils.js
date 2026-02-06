import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Safely parse a package.json file, returning null on failure.
 */
export async function readPackageJson(filePath) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (typeof pkg !== 'object' || pkg === null) return null;
    return pkg;
  } catch {
    return null;
  }
}

/**
 * Derive a human-readable project name from a package.json object and its path.
 */
export function projectName(pkg, pkgPath) {
  if (pkg.name && typeof pkg.name === 'string') return pkg.name;
  // Fall back to the directory name that contains the package.json
  const parts = pkgPath.split('/');
  // parts ends with "package.json", so the directory is one before that
  return parts.length >= 2 ? parts[parts.length - 2] : basename(pkgPath);
}
