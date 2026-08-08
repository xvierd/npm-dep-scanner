import Table from 'cli-table3';
import chalk from 'chalk';

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
    return reportJson(analysis);
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
    head: [chalk.cyan('Package'), ...matrix.projects.map((p) => chalk.cyan(p))],
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

function reportJson(analysis) {
  const serialiseMatrix = (m) => {
    if (!m) return null;
    const obj = {};
    for (const [pkg, versions] of m.rows) {
      obj[pkg] = { status: m.status.get(pkg) };
      for (const proj of m.projects) {
        const cell = versions.get(proj);
        obj[pkg][proj] = cell
          ? { version: cell.version, source: cell.source, declared: cell.declared }
          : null;
      }
    }
    return obj;
  };

  const output = {
    dependencies: serialiseMatrix(analysis.dependencies),
    mismatches: analysis.mismatches,
    compatible: analysis.compatible,
  };

  for (const key of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (analysis[key]) output[key] = serialiseMatrix(analysis[key]);
  }

  console.log(JSON.stringify(output, null, 2));
}
