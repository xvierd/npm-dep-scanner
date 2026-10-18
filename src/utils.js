import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

/**
 * Parse a package.json file, returning null on failure unless strict is enabled.
 */
export async function readPackageJson(filePath, { strict = false } = {}) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const pkg = JSON.parse(raw);
    if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
      throw new Error('expected a JSON object');
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      if (pkg[field] === undefined) continue;
      const dependencies = pkg[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
        || Object.values(dependencies).some((value) => typeof value !== 'string' || !value.trim())) {
        throw new Error(`${field} must map package names to nonempty version strings`);
      }
    }
    return pkg;
  } catch (error) {
    if (strict) throw new Error(`Cannot read package manifest ${filePath}: ${error.message}`, { cause: error });
    return null;
  }
}

/**
 * Derive a human-readable project name from a package.json object and its path.
 */
export function projectName(pkg, pkgPath) {
  if (pkg.name && typeof pkg.name === 'string') return pkg.name;
  // Fall back to the directory name that contains the package.json
  return basename(dirname(pkgPath));
}

/**
 * Build a package-name predicate from a --filter pattern.
 * Plain text matches as a case-insensitive substring; when the pattern
 * contains glob characters (* or ?) it is treated as a glob.
 * Returns null when no pattern was given.
 */
export function makeFilter(pattern) {
  if (!pattern) return null;
  if (typeof pattern !== 'string' || pattern.length > 1024) {
    throw new Error('Filter must be a string of at most 1024 characters');
  }

  if (!/[*?]/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(needle);
  }

  // Match simple wildcards without constructing a backtracking regular expression.
  const wildcard = pattern.toLowerCase();
  return (name) => {
    const value = name.toLowerCase();
    let input = 0;
    let token = 0;
    let star = -1;
    let retry = 0;
    while (input < value.length) {
      if (wildcard[token] === '*') {
        star = token++;
        retry = input;
      } else if (wildcard[token] === '?' || wildcard[token] === value[input]) {
        input++;
        token++;
      } else if (star !== -1) {
        token = star + 1;
        input = ++retry;
      } else return false;
    }
    while (wildcard[token] === '*') token++;
    return token === wildcard.length;
  };
}
