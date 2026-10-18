import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const INSTALL_FIELDS = DEPENDENCY_FIELDS.filter((field) => field !== 'peerDependencies');

// Read in precedence order; an unreadable or malformed existing lock must fail.
const READERS = [
  ['package-lock.json', packageLockReader, JSON.parse],
  ['pnpm-lock.yaml', pnpmLockReader, parseYaml],
  ['yarn.lock', yarnLockReader, parseYarnDescriptors],
];

/**
 * Read a lockfile from its root directory. With package context, resolve each
 * dependency for that project instead of choosing an arbitrary package version.
 * `projectPath` is relative to the lockfile directory ("." for its root).
 * An unresolved dependency returns undefined and should use its declared spec.
 * Pass a scan-local `cache` Map to reuse parsed locks between workspace members.
 */
export async function readLockfile(dir, options = {}) {
  for (const [file, reader, parse] of READERS) {
    const path = join(dir, file);
    let source;
    try {
      let pending = options.cache?.get(path);
      if (!pending) {
        pending = readFile(path, 'utf-8');
        options.cache?.set(path, pending);
      }
      source = await pending;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Cannot read lockfile ${path}: ${error.message}`, { cause: error });
    }
    try {
      const parsedKey = `${path}:parsed`;
      let parsed = options.cache?.get(parsedKey);
      if (!parsed) {
        parsed = parse(source);
        options.cache?.set(parsedKey, parsed);
      }
      const result = reader(source, options, parsed);
      if (result.versions.size > 0 || options.pkg) {
        return { type: file, ...result };
      }
    } catch (error) {
      throw new Error(`Cannot parse lockfile ${path}: ${error.message}`, { cause: error });
    }
  }
  return null;
}

/** Parse package-lock.json content (lockfileVersion 1, 2 and 3). */
export function parsePackageLock(raw, options = {}) {
  return packageLockReader(raw, options).versions;
}

function packageLockReader(raw, options, parsed) {
  const lock = parsed ?? JSON.parse(raw);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)
    || (!lock.packages && !lock.dependencies && !lock.lockfileVersion)) {
    throw new Error('Invalid package lock');
  }
  const projectPath = normalizeProjectPath(options.projectPath);
  const versions = new Map();
  let resolveVersion;

  if (lock.packages && typeof lock.packages === 'object') {
    if (!options.pkg) {
      const candidates = new Map();
      for (const [key, info] of Object.entries(lock.packages)) {
        const idx = key.lastIndexOf('node_modules/');
        if (idx === -1) continue;
        const name = key.slice(idx + 'node_modules/'.length);
        const version = packageEntryVersion(lock.packages, info);
        if (key === `node_modules/${name}` && version) versions.set(name, version);
        addCandidate(candidates, name, version);
      }
      fillUniqueVersions(versions, candidates);
    }

    resolveVersion = (name, declared, field) => {
      const packagePath = projectPath === '.' ? '' : projectPath;
      const storedDeclaration = lock.packages[packagePath]?.[field]?.[name];
      if (storedDeclaration !== undefined && storedDeclaration !== declared) return undefined;
      let directory = packagePath;
      while (true) {
        const key = posix.join(directory, 'node_modules', name);
        if (Object.hasOwn(lock.packages, key)) {
          return packageEntryVersion(lock.packages, lock.packages[key]);
        }
        if (!directory) return undefined;
        const parent = posix.dirname(directory);
        directory = parent === '.' ? '' : parent;
      }
    };
  } else if (lock.dependencies && typeof lock.dependencies === 'object') {
    if (!options.pkg) {
      // Register the entire root level before inspecting any nested duplicates.
      for (const [name, info] of Object.entries(lock.dependencies)) {
        if (typeof info?.version === 'string') versions.set(name, info.version);
      }
      const candidates = new Map();
      collectV1Deps(lock.dependencies, candidates);
      fillUniqueVersions(versions, candidates);
    }
    resolveVersion = (name) => {
      const version = projectPath === '.' ? lock.dependencies[name]?.version : undefined;
      return typeof version === 'string' ? version : undefined;
    };
  } else {
    resolveVersion = () => undefined;
  }

  return withProjectContext(versions, resolveVersion, options.pkg);
}

function packageEntryVersion(packages, info, seen = new Set()) {
  if (!info || typeof info !== 'object' || seen.has(info)) return undefined;
  seen.add(info);
  if (info.link && typeof info.resolved === 'string') {
    return packageEntryVersion(packages, packages[info.resolved], seen);
  }
  return typeof info.version === 'string' ? info.version : undefined;
}

function collectV1Deps(deps, candidates) {
  for (const [name, info] of Object.entries(deps)) {
    addCandidate(candidates, name, info?.version);
    if (info?.dependencies && typeof info.dependencies === 'object') {
      collectV1Deps(info.dependencies, candidates);
    }
  }
}

/** Parse pnpm-lock.yaml content, optionally for a particular importer. */
export function parsePnpmLock(raw, options = {}) {
  return pnpmLockReader(raw, options).versions;
}

function pnpmLockReader(raw, options, parsed) {
  const lock = parsed ?? parseYaml(raw);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('Invalid pnpm lock');
  const projectPath = normalizeProjectPath(options.projectPath);
  // v5/v6 standalone locks keep dependency sections directly at the root.
  const importer = lock.importers ? lock.importers[projectPath] : projectPath === '.' ? lock : undefined;
  const resolveVersion = (name, declared, field) => {
    if (!importer || typeof importer !== 'object') return undefined;
    const fields = INSTALL_FIELDS.includes(field) ? [field] : INSTALL_FIELDS;
    const candidates = new Set();
    for (const section of fields) {
      const info = importer[section]?.[name];
      const specifier = typeof info === 'object' && info ? info.specifier : importer.specifiers?.[name];
      if (specifier !== undefined && declared !== undefined && specifier !== declared) continue;
      const reference = typeof info === 'string' ? info : info?.version;
      const version = pnpmReferenceVersion(reference);
      if (version) candidates.add(version);
    }
    return onlyVersion(candidates);
  };

  const versions = new Map();
  let hasDirectSections = false;
  if (!options.pkg && importer && typeof importer === 'object') {
    const candidates = new Map();
    for (const section of INSTALL_FIELDS) {
      if (!importer[section] || typeof importer[section] !== 'object') continue;
      hasDirectSections = true;
      for (const [name, info] of Object.entries(importer[section])) {
        addCandidate(candidates, name, pnpmReferenceVersion(typeof info === 'string' ? info : info?.version));
      }
    }
    fillUniqueVersions(versions, candidates);
  }

  // Without project context, retain the useful index-only parser API. Multiple
  // installed versions cannot identify a direct dependency, so omit them.
  if (!hasDirectSections && !options.pkg) {
    const index = lock.packages || lock.snapshots;
    const candidates = new Map();
    if (index && typeof index === 'object') {
      for (const key of Object.keys(index)) {
        const parsed = parsePnpmPackageKey(key);
        if (parsed) addCandidate(candidates, parsed.name, parsed.version);
      }
    }
    fillUniqueVersions(versions, candidates);
  }

  return withProjectContext(versions, resolveVersion, options.pkg);
}

function cleanPnpmVersion(version) {
  // v5 uses "_peer@version"; v6/v9 use "(peer@version)".
  return version.replace(/\(.*$/, '').replace(/_.*$/, '');
}

function pnpmReferenceVersion(reference) {
  if (typeof reference !== 'string') return undefined;
  const version = cleanPnpmVersion(reference);
  return semver.valid(version) || parsePnpmPackageKey(reference)?.version;
}

// "/name/1.2.3" (v5), "/name@1.2.3" (v6), "name@1.2.3" (v9/aliases).
function parsePnpmPackageKey(key) {
  const value = key.replace(/^\//, '').replace(/\(.*$/, '');
  const match = value.match(/^(@[^/]+\/[^/@]+|[^/@]+)\/(.+)$/)
    || value.match(/^(@[^/]+\/[^@]+|[^@/]+)@(.+)$/);
  if (!match) return undefined;
  const version = semver.valid(cleanPnpmVersion(match[2]));
  return version ? { name: match[1], version } : undefined;
}

/** Parse Yarn classic or Berry, preserving descriptors for project resolution. */
export function parseYarnLock(raw, options = {}) {
  return yarnLockReader(raw, options).versions;
}

function yarnLockReader(raw, options, parsed) {
  const { berry, descriptors } = parsed ?? parseYarnDescriptors(raw);
  const versions = new Map();
  if (!options.pkg) {
    const candidates = new Map();
    for (const [descriptor, choices] of descriptors) {
      const name = descriptorName(descriptor);
      if (name) {
        for (const version of choices) addCandidate(candidates, name, version);
      }
    }
    fillUniqueVersions(versions, candidates);
  }

  const resolveVersion = (name, declared) => {
    if (typeof declared !== 'string') return undefined;
    const keys = [`${name}@${declared}`];
    // Berry makes the default registry protocol explicit in descriptor keys.
    if (berry && !/^[a-z][a-z\d+.-]*:/i.test(declared)) keys.push(`${name}@npm:${declared}`);
    const matches = new Set(keys.flatMap((key) => [...(descriptors.get(key) || [])]));
    return onlyVersion(matches);
  };
  return withProjectContext(versions, resolveVersion, options.pkg);
}

function parseYarnDescriptors(raw) {
  const berry = /^__metadata:/m.test(raw);
  const descriptors = berry ? yarnBerryDescriptors(raw) : yarnClassicDescriptors(raw);
  if (!berry && descriptors.size === 0 && !/^# yarn lockfile v1\s*$/m.test(raw)) {
    throw new Error('Invalid Yarn lockfile');
  }
  return { berry, descriptors };
}

function yarnClassicDescriptors(raw) {
  const descriptors = new Map();
  let current = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = line.replace(/:\s*$/, '')
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((descriptor) => descriptor.trim().replace(/^"|"$/g, ''));
    } else {
      // Exactly one level: a nested dependency named "version" is not this field.
      const match = line.match(/^ {2}version\s+"?([^"\s]+)"?/);
      if (match) {
        for (const descriptor of current) addCandidate(descriptors, descriptor, match[1]);
      }
    }
  }
  return descriptors;
}

function yarnBerryDescriptors(raw) {
  const descriptors = new Map();
  const doc = parseYaml(raw);
  if (!doc || typeof doc !== 'object') return descriptors;
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata' || typeof entry?.version !== 'string') continue;
    for (const descriptor of key.split(/,\s*/)) addCandidate(descriptors, descriptor, entry.version);
  }
  return descriptors;
}

function descriptorName(descriptor) {
  const at = descriptor.indexOf('@', 1);
  return at === -1 ? undefined : descriptor.slice(0, at);
}

function normalizeProjectPath(projectPath = '.') {
  const normalized = posix.normalize(projectPath.replace(/\\/g, '/'));
  if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Project path must be inside the lockfile directory');
  }
  return normalized.replace(/\/$/, '') || '.';
}

function addCandidate(candidates, name, version) {
  if (typeof version !== 'string') return;
  if (!candidates.has(name)) candidates.set(name, new Set());
  candidates.get(name).add(version);
}

function onlyVersion(candidates) {
  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

function fillUniqueVersions(versions, candidates) {
  for (const [name, choices] of candidates) {
    const version = onlyVersion(choices);
    if (!versions.has(name) && version !== undefined) versions.set(name, version);
  }
}

function withProjectContext(versions, resolveVersion, pkg) {
  if (!pkg) return { versions };
  // A peer range is a contract for consumers, not the copy installed for this
  // project's development. Keep comparing the declared peer constraint.
  const resolveDependency = (name, declared, field) => field === 'peerDependencies'
    ? undefined
    : resolveVersion(name, declared, field);
  const candidates = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, declared] of Object.entries(pkg[field] || {})) {
      addCandidate(candidates, name, resolveDependency(name, declared, field));
    }
  }
  const directVersions = new Map();
  fillUniqueVersions(directVersions, candidates);
  return { versions: directVersions, resolveVersion: resolveDependency };
}
