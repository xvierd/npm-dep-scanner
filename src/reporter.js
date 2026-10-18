import Table from 'cli-table3';
import chalk from 'chalk';
import { posix } from 'node:path';
import { validateComparison } from './semver-utils.js';

const SECTIONS = [
  ['dependencies', 'Dependencies'],
  ['devDependencies', 'Dev Dependencies'],
  ['peerDependencies', 'Peer Dependencies'],
  ['optionalDependencies', 'Optional Dependencies'],
];

/**
 * Print the analysis results as coloured tables or as JSON.
 */
export function report(analysis, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(toJsonReport(analysis), null, 2));
    return;
  }

  let first = true;
  for (const [key, title] of SECTIONS) {
    const matrix = analysis[key];
    if (!matrix) continue;
    if (matrix.packages.length === 0 && key !== 'dependencies') continue;
    if (!first) console.log();
    printTable(title, matrix, analysis);
    first = false;
  }

  console.log();
  if (analysis.mismatches.length > 0) {
    console.log(
      chalk.yellow(`\u26A0 ${analysis.mismatches.length} version mismatch${analysis.mismatches.length === 1 ? '' : 'es'} found: ${analysis.mismatches.join(', ')}`)
    );
  } else {
    console.log(chalk.green('\u2714 All dependency versions are consistent across projects.'));
  }
  if (analysis.compatible.length > 0) {
    console.log(
      chalk.green(`\u2248 ${analysis.compatible.length} package${analysis.compatible.length === 1 ? '' : 's'} with different but compatible ranges: ${analysis.compatible.join(', ')}`)
    );
  }
}

function printTable(title, matrix, analysis) {
  if (matrix.packages.length === 0) {
    console.log(`${title}: (none)`);
    return;
  }

  console.log(chalk.bold(`${title}:`));

  const table = new Table({
    head: [chalk.cyan('Package'), ...matrix.projects.map((p) => chalk.cyan(matrix.projectLabels.get(p)))],
    style: { head: [], border: [] },
  });

  for (const pkg of matrix.packages) {
    const versions = matrix.rows.get(pkg);
    const status = matrix.status.get(pkg);

    const row = [status === 'mismatch' ? chalk.yellow(pkg) : pkg];

    for (const proj of matrix.projects) {
      const cell = versions.get(proj);
      if (!cell) {
        row.push(chalk.dim('\u2014'));
      } else {
        // '*' marks a version resolved from a lockfile
        const text = cell.version + (cell.source !== 'package.json' ? chalk.dim('*') : '');
        if (status === 'mismatch') {
          row.push(chalk.yellow(text));
        } else if (status === 'compatible') {
          row.push(chalk.green(text));
        } else {
          row.push(text);
        }
      }
    }

    table.push(row);
  }

  console.log(table.toString());

  const legend = [];
  if (matrixHasLockfileVersions(matrix)) legend.push(chalk.dim('* version from lockfile'));
  if (matrix.packages.some((p) => matrix.status.get(p) === 'compatible')) {
    legend.push(chalk.green('green = different but compatible ranges'));
  }
  if (legend.length > 0) console.log(`  ${legend.join(chalk.dim(' · '))}`);
}

function matrixHasLockfileVersions(matrix) {
  for (const versions of matrix.rows.values()) {
    for (const cell of versions.values()) {
      if (cell.source !== 'package.json') return true;
    }
  }
  return false;
}

/** Portable, deterministic schema v1 for scripts and CI consumers. */
export function toJsonReport(analysis) {
  const comparison = analysis.comparison ?? 'compatible';
  validateComparison(comparison);
  const projects = analysis.projects.map((project) => {
    const path = portablePath(project.path);
    return { internalId: project.id, id: path, path, name: project.name };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new Error('Duplicate relative project paths in JSON report.');
  }

  const output = emptyJsonReport(comparison);
  output.projects = projects.map(({ id, path, name }) => ({ id, path, name }));
  const packages = new Set();
  for (const [field] of SECTIONS) {
    const matrix = analysis[field];
    if (!matrix) continue;
    output[field] = dictionary([...matrix.rows.keys()].sort().map((name) => {
      packages.add(name);
      const cells = matrix.rows.get(name);
      const versions = dictionary(projects.map(({ internalId, id }) => {
        const cell = cells.get(internalId);
        return [id, cell ? {
          version: cell.version,
          declared: cell.declared,
          resolved: cell.resolved ?? null,
          source: cell.source,
        } : null];
      }));
      return [name, { status: matrix.status.get(name), versions }];
    }));
  }
  output.mismatches = [...new Set(analysis.mismatches)].sort();
  output.compatible = [...new Set(analysis.compatible)].sort();
  output.status = output.mismatches.length > 0 ? 'mismatch' : 'ok';
  output.summary = {
    projects: projects.length,
    packages: packages.size,
    mismatches: output.mismatches.length,
    compatible: output.compatible.length,
  };
  return output;
}

/** Error output has the same top-level fields as a successful report. */
export function errorJsonReport(error, { comparison = 'compatible', code = 'SCAN_ERROR' } = {}) {
  validateComparison(comparison);
  const output = emptyJsonReport(comparison);
  output.status = 'error';
  output.errors = [{ code, message: error instanceof Error ? error.message : String(error) }];
  return output;
}

function emptyJsonReport(comparison) {
  return {
    schemaVersion: 1,
    status: 'ok',
    comparison,
    projects: [],
    dependencies: null,
    devDependencies: null,
    peerDependencies: null,
    optionalDependencies: null,
    mismatches: [],
    compatible: [],
    summary: { projects: 0, packages: 0, mismatches: 0, compatible: 0 },
    errors: [],
  };
}

function portablePath(path) {
  if (typeof path !== 'string') throw new Error('JSON reports require relative project paths.');
  const normalized = posix.normalize(path.replace(/\\/g, '/'));
  if (posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)
    || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('JSON reports require project paths relative to the scan root.');
  }
  return normalized.replace(/\/$/, '') || '.';
}

function dictionary(entries) {
  return Object.assign(Object.create(null), Object.fromEntries(entries));
}
