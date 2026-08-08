import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Lockfile readers, in precedence order. When several lockfiles exist in the
 * same directory the first one that parses wins.
 */
const READERS = [
  ['package-lock.json', parsePackageLock],
  ['pnpm-lock.yaml', parsePnpmLock],
  ['yarn.lock', parseYarnLock],
];

/**
 * Look for a lockfile in `dir` and extract the installed versions.
 *
 * @param {string} dir — directory that contains a package.json
 * @returns {Promise<{ type: string, versions: Map<string, string> } | null>}
 *   `type` is the lockfile name; `versions` maps package name -> installed version.
 */
export async function readLockfile(dir) {
  for (const [file, parser] of READERS) {
    let raw;
    try {
      raw = await readFile(join(dir, file), 'utf-8');
    } catch {
      continue; // file does not exist
    }
    try {
      const versions = parser(raw);
      if (versions && versions.size > 0) {
        return { type: file, versions };
      }
    } catch {
      // invalid lockfile — try the next one
    }
  }
  return null;
}

/**
 * Parse package-lock.json content (lockfileVersion 1, 2 and 3).
 */
export function parsePackageLock(raw) {
  const lock = JSON.parse(raw);
  const versions = new Map();

  if (lock.packages && typeof lock.packages === 'object') {
    // v2/v3: keys are paths like "node_modules/foo" or "node_modules/a/node_modules/b".
    // First pass: top-level entries win.
    for (const [key, info] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/')) continue;
      const name = key.slice('node_modules/'.length);
      if (name.includes('node_modules/')) continue;
      if (info && typeof info.version === 'string') versions.set(name, info.version);
    }
    // Second pass: nested entries only fill gaps.
    for (const [key, info] of Object.entries(lock.packages)) {
      const idx = key.lastIndexOf('node_modules/');
      if (idx === -1) continue;
      const name = key.slice(idx + 'node_modules/'.length);
      if (info && typeof info.version === 'string' && !versions.has(name)) {
        versions.set(name, info.version);
      }
    }
  } else if (lock.dependencies && typeof lock.dependencies === 'object') {
    // v1: nested "dependencies" objects.
    collectV1Deps(lock.dependencies, versions);
  }

  return versions;
}

function collectV1Deps(deps, versions) {
  for (const [name, info] of Object.entries(deps)) {
    if (info && typeof info.version === 'string' && !versions.has(name)) {
      versions.set(name, info.version);
    }
    if (info && info.dependencies && typeof info.dependencies === 'object') {
      collectV1Deps(info.dependencies, versions);
    }
  }
}

/**
 * Parse pnpm-lock.yaml content.
 */
export function parsePnpmLock(raw) {
  const lock = parseYaml(raw);
  const versions = new Map();
  if (!lock || typeof lock !== 'object') return versions;

  // Preferred: the root importer records the exact installed version per direct dep.
  const importer = lock.importers && lock.importers['.'];
  if (importer && typeof importer === 'object') {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = importer[section];
      if (!deps || typeof deps !== 'object') continue;
      for (const [name, info] of Object.entries(deps)) {
        const v = typeof info === 'string' ? info : info && info.version;
        if (typeof v === 'string') versions.set(name, cleanPnpmVersion(v));
      }
    }
  }

  // Fallback: derive from the packages/snapshots index keys.
  if (versions.size === 0) {
    const index = lock.packages || lock.snapshots;
    if (index && typeof index === 'object') {
      for (const key of Object.keys(index)) {
        const parsed = parsePnpmPackageKey(key);
        if (parsed && !versions.has(parsed.name)) versions.set(parsed.name, parsed.version);
      }
    }
  }

  return versions;
}

// "1.2.3(react@18.2.0)" -> "1.2.3"
function cleanPnpmVersion(v) {
  return v.replace(/\(.*\)$/, '');
}

// "/name/1.2.3" (lockfile v5), "/name@1.2.3" (v6) or "name@1.2.3" (v9) -> { name, version }
function parsePnpmPackageKey(key) {
  const k = key.replace(/^\//, '');
  let m = k.match(/^(@[^/]+\/[^@/]+|[^@/]+)\/([^/()]+)$/); // v5: name/version
  if (m) return { name: m[1], version: cleanPnpmVersion(m[2]) };
  m = k.match(/^(@[^/]+\/[^@]+|[^@]+)@([^()]+)$/); // v6/v9: name@version
  if (m) return { name: m[1], version: cleanPnpmVersion(m[2]) };
  return null;
}

/**
 * Parse yarn.lock content — v1 (classic, custom format) and v2+ (YAML).
 */
export function parseYarnLock(raw) {
  if (/^__metadata:/m.test(raw)) {
    return parseYarnBerry(raw);
  }
  return parseYarnClassic(raw);
}

// Yarn classic (v1): stanzas of descriptor headers followed by indented fields.
function parseYarnClassic(raw) {
  const versions = new Map();
  let currentNames = [];

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      // Header line: `name@range:` or `"a@1", "a@2":`
      currentNames = line
        .replace(/:\s*$/, '')
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((d) => descriptorName(d.trim().replace(/^"|"$/g, '')))
        .filter(Boolean);
    } else {
      const m = line.match(/^\s+version\s+"?([^"\s]+)"?/);
      if (m) {
        for (const name of currentNames) {
          if (!versions.has(name)) versions.set(name, m[1]);
        }
      }
    }
  }

  return versions;
}

// Yarn berry (v2+): valid YAML with descriptor keys.
function parseYarnBerry(raw) {
  const versions = new Map();
  const doc = parseYaml(raw);
  if (!doc || typeof doc !== 'object') return versions;

  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    if (!entry || typeof entry.version !== 'string') continue;
    // A key can hold several descriptors: "pkg@npm:^1.0.0, pkg@npm:^1.1.0"
    for (const descriptor of key.split(/,\s*/)) {
      const name = descriptorName(descriptor);
      if (name && !versions.has(name)) versions.set(name, entry.version);
    }
  }

  return versions;
}

// "lodash@^4.17.21" -> "lodash", "@scope/name@npm:^1.0.0" -> "@scope/name"
function descriptorName(descriptor) {
  if (!descriptor) return null;
  const at = descriptor.indexOf('@', 1);
  if (at === -1) return null;
  return descriptor.slice(0, at);
}
