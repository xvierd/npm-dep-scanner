import { classifyRow, validateComparison } from './semver-utils.js';

/**
 * Build dependency matrices from an array of project objects.
 *
 * @param {Array} projects — project objects with `.pkg` and optional `.lockfile`
 * @param {Object} opts
 * @param {'compatible'|'exact'} opts.comparison — comparison policy
 * @param {boolean} opts.includeProd      — process dependencies (default true)
 * @param {boolean} opts.includeDev       — also process devDependencies
 * @param {boolean} opts.includePeer      — also process peerDependencies
 * @param {boolean} opts.includeOptional  — also process optionalDependencies
 * @param {boolean} opts.mismatchesOnly   — only return rows that mismatch
 * @param {boolean} opts.useDeclared      — ignore lockfiles, use declared ranges
 * @param {Function|null} opts.filter     — predicate on package names
 * @returns {{ comparison: 'compatible'|'exact', dependencies: Matrix|null, devDependencies: Matrix|null,
 *   peerDependencies: Matrix|null, optionalDependencies: Matrix|null,
 *   mismatches: string[], compatible: string[] }}
 *
 * A Matrix is {
 *   packages: string[],
 *   projects: string[], // stable project IDs
 *   projectLabels: Map<string, string>,
 *   rows: Map<string, Map<string, { version: string, source: string, declared: string, resolved: string|null }>>,
 *   status: Map<string, 'match' | 'compatible' | 'mismatch'>
 * }
 *
 * `source` is the lockfile name when the version comes from a lockfile,
 * or 'package.json' when it is the declared range. `declared` always keeps
 * the range written in package.json. `resolved` is null when no lock resolution
 * is used (including --declared and peer dependency contracts).
 */
export function analyzeProjects(projects, {
  comparison = 'compatible',
  includeProd = true,
  includeDev = false,
  includePeer = false,
  includeOptional = false,
  mismatchesOnly = false,
  useDeclared = false,
  filter = null,
} = {}) {
  validateComparison(comparison);
  const projectInfo = describeProjects(projects);
  const matrices = {};
  if (includeProd) matrices.dependencies = buildMatrix(projects, projectInfo, 'dependencies', useDeclared);
  if (includeDev) matrices.devDependencies = buildMatrix(projects, projectInfo, 'devDependencies', useDeclared);
  if (includePeer) matrices.peerDependencies = buildMatrix(projects, projectInfo, 'peerDependencies', useDeclared);
  if (includeOptional) matrices.optionalDependencies = buildMatrix(projects, projectInfo, 'optionalDependencies', useDeclared);

  for (const matrix of Object.values(matrices)) {
    classifyMatrix(matrix, comparison);
    if (filter) filterMatrix(matrix, filter);
    if (mismatchesOnly) keepOnlyMismatches(matrix);
  }

  const all = Object.values(matrices);
  const collect = (wanted) => [
    ...new Set(all.flatMap((m) => m.packages.filter((p) => m.status.get(p) === wanted))),
  ].sort();

  return {
    comparison,
    projects: projectInfo,
    dependencies: matrices.dependencies ?? null,
    devDependencies: matrices.devDependencies ?? null,
    peerDependencies: matrices.peerDependencies ?? null,
    optionalDependencies: matrices.optionalDependencies ?? null,
    mismatches: collect('mismatch'),
    compatible: collect('compatible'),
  };
}

function describeProjects(projects) {
  const counts = new Map();
  for (const { name } of projects) counts.set(name, (counts.get(name) ?? 0) + 1);
  const ids = new Set();
  const labels = new Set();
  return projects.map((project, index) => {
    const id = project.id ?? project.absolutePath ?? project.relativePath ?? `project:${index}`;
    if (ids.has(id)) throw new Error(`Duplicate project path: ${id}`);
    ids.add(id);
    const path = project.relativePath ?? project.absolutePath ?? id;
    let label = counts.get(project.name) > 1 || labels.has(project.name)
      ? `${project.name} (${path})` : project.name;
    const base = label;
    for (let suffix = 2; labels.has(label); suffix++) label = `${base} [${suffix}]`;
    labels.add(label);
    return { id, name: project.name, path, label };
  });
}

function buildMatrix(projects, projectInfo, field, useDeclared) {
  // rows: packageName -> Map(projectId -> { version, source, declared, resolved })
  const rows = new Map();

  for (const [index, project] of projects.entries()) {
    const deps = project.pkg[field];
    if (!deps || typeof deps !== 'object') continue;

    for (const [pkg, declared] of Object.entries(deps)) {
      if (!rows.has(pkg)) rows.set(pkg, new Map());
      rows.get(pkg).set(projectInfo[index].id, resolveVersion(project, pkg, declared, useDeclared, field));
    }
  }

  // Sort rows alphabetically
  const sorted = new Map([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    packages: [...sorted.keys()],
    projects: projectInfo.map((p) => p.id),
    projectLabels: new Map(projectInfo.map((p) => [p.id, p.label])),
    rows: sorted,
    status: new Map(),
  };
}

// Prefer the version resolved for this project; never guess from a transitive entry.
function resolveVersion(project, pkg, declared, useDeclared, field) {
  const lockfile = !useDeclared && field !== 'peerDependencies' && project.lockfile;
  const locked = lockfile && (lockfile.resolveVersion
    ? lockfile.resolveVersion(pkg, declared, field)
    : lockfile.versions.get(pkg));
  if (typeof locked === 'string') {
    return { version: locked, source: lockfile.type, declared, resolved: locked };
  }
  return { version: declared, source: 'package.json', declared, resolved: null };
}

function classifyMatrix(matrix, comparison) {
  for (const [pkg, versions] of matrix.rows) {
    matrix.status.set(pkg, classifyRow([...versions.values()].map((v) => v.version), comparison));
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
