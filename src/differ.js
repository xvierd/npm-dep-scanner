import chalk from 'chalk';
import Table from 'cli-table3';
import { classifyRow } from './semver-utils.js';

/**
 * Print a diff view of dependency version differences between projects.
 * Shows a table per project pair with only the packages that differ,
 * applying the same comparison policy as the analysis.
 */
export function printDiff(analysis) {
  const matrices = [
    'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies',
  ].map((section) => ({ section, matrix: analysis[section] })).filter(({ matrix }) => matrix);

  const projects = analysis.projects.map((project) => project.id);
  const labels = new Map(analysis.projects.map((project) => [project.id, project.label]));
  const comparison = analysis.comparison ?? 'compatible';

  if (projects.length < 2) {
    console.log(chalk.dim('Need at least 2 projects to show a diff.\n'));
    return;
  }

  let hasDiffs = false;
  const reportedRows = new Set();

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i];
      const b = projects[j];
      const labelA = labels.get(a);
      const labelB = labels.get(b);
      const diffs = [];

      for (const { section, matrix } of matrices) {
        for (const [pkg, versions] of matrix.rows) {
          const cellA = versions.get(a) ?? null;
          const cellB = versions.get(b) ?? null;
          if (!cellA || !cellB) continue;   // skip if only one project has it
          if (classifyRow([cellA.version, cellB.version], comparison) !== 'mismatch') continue;
          diffs.push({ section, pkg, cellA, cellB });
          reportedRows.add(versions);
        }
      }

      if (diffs.length === 0) continue;
      hasDiffs = true;

      // Header
      console.log(chalk.bold(`${labelA}  ${chalk.dim('vs')}  ${labelB}`));

      // Table
      const table = new Table({
        head: [chalk.cyan('Section'), chalk.cyan('Package'), chalk.red(labelA), chalk.green(labelB)],
        style: { head: [], border: [] },
      });

      for (const { section, pkg, cellA, cellB } of diffs) {
        table.push([
          section,
          chalk.yellow(pkg),
          formatCell(cellA, chalk.red),
          formatCell(cellB, chalk.green),
        ]);
      }

      console.log(table.toString());
      console.log();
    }
  }

  // OR ranges can intersect in every pair without having a version common to
  // the full group. Keep these CI conflicts visible in the diff as well.
  const groupConflicts = matrices.flatMap(({ section, matrix }) => [...matrix.rows]
    .filter(([pkg, versions]) => matrix.status.get(pkg) === 'mismatch' && !reportedRows.has(versions))
    .map(([pkg, versions]) => ({ section, pkg, versions })));
  if (groupConflicts.length > 0) {
    hasDiffs = true;
    console.log(chalk.bold('No common version satisfies all project ranges:'));
    const table = new Table({
      head: [chalk.cyan('Section'), chalk.cyan('Package'), ...projects.map((id) => chalk.cyan(labels.get(id)))],
      style: { head: [], border: [] },
    });
    for (const { section, pkg, versions } of groupConflicts) {
      table.push([section, chalk.yellow(pkg), ...projects.map((id) => formatCell(versions.get(id), chalk.yellow))]);
    }
    console.log(table.toString());
    console.log();
  }

  if (!hasDiffs) {
    console.log(chalk.green('No differences found between the selected projects.\n'));
  }
}

function formatCell(cell, colour) {
  if (!cell) return chalk.dim('—');
  const text = cell.version + (cell.source !== 'package.json' ? chalk.dim('*') : '');
  return colour(text);
}
