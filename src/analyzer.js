import { classifyRow } from './semver-utils.js';

/**
 * Build dependency matrices from an array of project objects.
 *
 * @param {Array} projects — project objects with `.pkg` and optional `.lockfile`
 * @param {Object} opts
 * @param {boolean} opts.includeDev       — also process devDependencies
 * @param {boolean} opts.includePeer      — also process peerDependencies
 * @param {boolean} opts.includeOptional  — also process optionalDependencies
 * @param {boolean} opts.mismatchesOnly   — only return rows that mismatch
 * @param {boolean} opts.useDeclared      — ignore lockfiles, use declared ranges
 * @param {Function|null} opts.filter     — predicate on package names
 * @returns {{ dependencies: Matrix, devDependencies: Matrix|null,
 *   peerDependencies: Matrix|null, optionalDependencies: Matrix|null,
 *   mismatches: string[], compatible: string[] }}
 *
 * A Matrix is {
 *   packages: string[],
 *   projects: string[],
 *   rows: Map<string, Map<string, { version: string, source: string, declared: string }>>,
 *   status: Map<string, 'match' | 'compatible' | 'mismatch'>
 * }
 *
 * `source` is the lockfile name when the version comes from a lockfile,
 * or 'package.json' when it is the declared range. `declared` always keeps
 * the range written in package.json.
 */
export function analyzeProjects(projects, {
  includeDev = false,
  includePeer = false,
  includeOptional = false,
  mismatchesOnly = false,
  useDeclared = false,
  filter = null,
} = {}) {
  const matrices = { dependencies: buildMatrix(projects, 'dependencies', useDeclared) };
  if (includeDev) matrices.devDependencies = buildMatrix(projects, 'devDependencies', useDeclared);
  if (includePeer) matrices.peerDependencies = buildMatrix(projects, 'peerDependencies', useDeclared);
  if (includeOptional) matrices.optionalDependencies = buildMatrix(projects, 'optionalDependencies', useDeclared);

  for (const matrix of Object.values(matrices)) {
    classifyMatrix(matrix);
    if (filter) filterMatrix(matrix, filter);
    if (mismatchesOnly) keepOnlyMismatches(matrix);
  }

  const all = Object.values(matrices);
  const collect = (wanted) => [
    ...new Set(all.flatMap((m) => m.packages.filter((p) => m.status.get(p) === wanted))),
  ];

  return {
    dependencies: matrices.dependencies,
    devDependencies: matrices.devDependencies ?? null,
    peerDependencies: matrices.peerDependencies ?? null,
    optionalDependencies: matrices.optionalDependencies ?? null,
    mismatches: collect('mismatch'),
    compatible: collect('compatible'),
  };
}

function buildMatrix(projects, field, useDeclared) {
  const projectNames = projects.map((p) => p.name);
  // rows: packageName -> Map(projectName -> { version, source, declared })
  const rows = new Map();

  for (const project of projects) {
    const deps = project.pkg[field];
    if (!deps || typeof deps !== 'object') continue;

    for (const [pkg, declared] of Object.entries(deps)) {
      if (!rows.has(pkg)) rows.set(pkg, new Map());
      rows.get(pkg).set(project.name, resolveVersion(project, pkg, declared, useDeclared));
    }
  }

  // Sort rows alphabetically
  const sorted = new Map([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return { packages: [...sorted.keys()], projects: projectNames, rows: sorted, status: new Map() };
}

// Prefer the installed version from the lockfile; fall back to the declared range.
function resolveVersion(project, pkg, declared, useDeclared) {
  const locked = !useDeclared && project.lockfile && project.lockfile.versions.get(pkg);
  if (typeof locked === 'string') {
    return { version: locked, source: project.lockfile.type, declared };
  }
  return { version: declared, source: 'package.json', declared };
}

function classifyMatrix(matrix) {
  for (const [pkg, versions] of matrix.rows) {
    matrix.status.set(pkg, classifyRow([...versions.values()].map((v) => v.version)));
  }
}

function filterMatrix(matrix, predicate) {
  for (const pkg of [...matrix.rows.keys()]) {
    if (!predicate(pkg)) {
      matrix.rows.delete(pkg);
      matrix.status.delete(pkg);
    }
  }
  matrix.packages = [...matrix.rows.keys()];
}

function keepOnlyMismatches(matrix) {
  for (const pkg of [...matrix.rows.keys()]) {
    if (matrix.status.get(pkg) !== 'mismatch') {
      matrix.rows.delete(pkg);
      matrix.status.delete(pkg);
    }
  }
  matrix.packages = [...matrix.rows.keys()];
}
