import chalk from 'chalk';
import Table from 'cli-table3';
import { classifyRow } from './semver-utils.js';

/**
 * Print a diff view of dependency version differences between projects.
 * Shows a table per project pair with only the packages that differ,
 * skipping rows whose ranges are semver-compatible.
 */
export function printDiff(analysis) {
  const matrices = [
    analysis.dependencies,
    analysis.devDependencies,
    analysis.peerDependencies,
    analysis.optionalDependencies,
  ].filter(Boolean);

  const projects = analysis.dependencies.projects;

  if (projects.length < 2) {
    console.log(chalk.dim('Need at least 2 projects to show a diff.\n'));
    return;
  }

  let hasDiffs = false;

  for (let i = 0; i < projects.length; i++) {
    for (let j = i + 1; j < projects.length; j++) {
      const a = projects[i];
      const b = projects[j];
      const diffs = [];

      for (const matrix of matrices) {
        for (const [pkg, versions] of matrix.rows) {
          const cellA = versions.get(a) ?? null;
          const cellB = versions.get(b) ?? null;
          if (!cellA || !cellB) continue;   // skip if only one project has it
          if (classifyRow([cellA.version, cellB.version]) !== 'mismatch') continue;
          diffs.push({ pkg, cellA, cellB });
        }
      }

      if (diffs.length === 0) continue;
      hasDiffs = true;

      // Header
      console.log(chalk.bold(`${a}  ${chalk.dim('vs')}  ${b}`));

      // Table
      const table = new Table({
        head: [chalk.cyan('Package'), chalk.red(a), chalk.green(b)],
        style: { head: [], border: [] },
      });

      for (const { pkg, cellA, cellB } of diffs) {
        table.push([
          chalk.yellow(pkg),
          formatCell(cellA, chalk.red),
          formatCell(cellB, chalk.green),
        ]);
      }

      console.log(table.toString());
      console.log();
    }
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
