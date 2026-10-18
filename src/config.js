import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validatePatterns } from './patterns.js';

const CONFIG_NAME = '.npm-dep-scanner.json';
const DEPENDENCY_TYPES = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const CONFIG_KEYS = new Set([
  '$schema', 'schemaVersion', 'exclude', 'ignorePackages', 'comparison',
  'dependencyTypes', 'versionSource', 'maxDepth',
]);

function configError(path, detail, cause) {
  const error = new Error(`Invalid configuration ${path}: ${detail}`, cause ? { cause } : undefined);
  error.code = 'CONFIG_ERROR';
  return error;
}

/** Validate a config or merged CLI options, returning fresh normalized values. */
export function validateConfig(input, { path = '<configuration>' } = {}) {
  const invalid = (detail) => { throw configError(path, detail); };
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    invalid('expected a JSON object');
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!CONFIG_KEYS.has(key)) invalid(`unknown property ${String(key)}`);
  }
  if (Object.hasOwn(input, '$schema') && typeof input.$schema !== 'string') {
    invalid('$schema must be a string');
  }
  if (Object.hasOwn(input, 'schemaVersion') && input.schemaVersion !== 1) {
    invalid('schemaVersion must be 1');
  }

  const config = {
    schemaVersion: 1,
    exclude: [],
    ignorePackages: [],
    comparison: 'compatible',
    dependencyTypes: ['dependencies'],
    versionSource: 'resolved',
    maxDepth: 10,
  };

  for (const key of ['exclude', 'ignorePackages']) {
    if (!Object.hasOwn(input, key)) continue;
    const patterns = input[key];
    if (!Array.isArray(patterns) || patterns.length > 128 || patterns.some((pattern) => typeof pattern !== 'string')) {
      invalid(`${key} must be an array of at most 128 strings`);
    }
    if (patterns.some((pattern) => {
      const relativePattern = pattern.replace(/^(?:\.\/)+/, '');
      return relativePattern.startsWith('!') && !relativePattern.startsWith('!(');
    })) {
      invalid(`${key} does not support !pattern reinclusion; use only exclusion patterns`);
    }
    try {
      validatePatterns(patterns, { label: key });
    } catch (error) {
      throw configError(path, error.message, error);
    }
    config[key] = [...patterns];
  }

  for (const [key, choices] of [
    ['comparison', ['compatible', 'exact']],
    ['versionSource', ['resolved', 'declared']],
  ]) {
    if (!Object.hasOwn(input, key)) continue;
    if (!choices.includes(input[key])) invalid(`${key} must be one of: ${choices.join(', ')}`);
    config[key] = input[key];
  }

  if (Object.hasOwn(input, 'dependencyTypes')) {
    const types = input.dependencyTypes;
    if (!Array.isArray(types) || types.length === 0 || [...types].some((type) => !DEPENDENCY_TYPES.includes(type))) {
      invalid(`dependencyTypes must be a nonempty array containing only: ${DEPENDENCY_TYPES.join(', ')}`);
    }
    if (new Set(types).size !== types.length) invalid('dependencyTypes must not contain duplicates');
    config.dependencyTypes = [...types];
  }
  if (Object.hasOwn(input, 'maxDepth')) {
    if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > 100) {
      invalid('maxDepth must be an integer between 0 and 100');
    }
    config.maxDepth = input.maxDepth;
  }
  return config;
}

async function readConfig(path, { optional = false } = {}) {
  try {
    await lstat(path);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw configError(path, error.message, error);
  }
  let canonicalPath = path;
  let input;
  try {
    canonicalPath = await realpath(path);
    input = JSON.parse(await readFile(canonicalPath, 'utf-8'));
  } catch (error) {
    throw configError(canonicalPath, error.message, error);
  }
  return {
    config: validateConfig(input, { path: canonicalPath }),
    path: canonicalPath,
    baseDir: dirname(canonicalPath),
  };
}

/** Find the nearest config, stopping at the current repository's .git boundary. */
export async function loadConfig(rootDir, { configFile, enabled = true } = {}) {
  const scanRoot = resolve(rootDir);
  const empty = () => ({ config: validateConfig({}), path: null, baseDir: scanRoot });
  if (typeof enabled !== 'boolean') throw configError(scanRoot, 'enabled must be a boolean');
  if (configFile !== undefined && !enabled) {
    throw configError(scanRoot, 'an explicit config file cannot be combined with disabled configuration');
  }
  if (!enabled) return empty();
  if (configFile !== undefined) {
    if (typeof configFile !== 'string' || !configFile) {
      throw configError(scanRoot, 'configFile must be a nonempty path string');
    }
    return readConfig(resolve(configFile));
  }

  let discoveryRoot;
  try {
    discoveryRoot = await realpath(scanRoot);
  } catch (error) {
    throw configError(scanRoot, error.message, error);
  }
  for (let directory = discoveryRoot; ; directory = dirname(directory)) {
    const result = await readConfig(join(directory, CONFIG_NAME), { optional: true });
    if (result) return result;
    const gitPath = join(directory, '.git');
    try {
      await lstat(gitPath);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw configError(gitPath, error.message, error);
    }
    if (dirname(directory) === directory) break;
  }
  return empty();
}
