import chalk from 'chalk';
import Table from 'cli-table3';

/**
 * Print a diff view of dependency version differences between projects.
 * Shows a table per project pair with only the packages that differ,
 * followed by a git-diff-style text summary.
 */
export function printDiff(analysis) {
  const matrices = [analysis.dependencies];
  if (analysis.devDependencies) matrices.push(analysis.devDependencies);

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
          const verA = versions.get(a) ?? null;
          const verB = versions.get(b) ?? null;
          if (!verA || !verB) continue;   // skip if only one project has it
          if (verA === verB) continue;    // skip if versions match
          diffs.push({ pkg, verA, verB });
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

      for (const { pkg, verA, verB } of diffs) {
        table.push([
          chalk.yellow(pkg),
          verA ? chalk.red(verA) : chalk.dim('—'),
          verB ? chalk.green(verB) : chalk.dim('—'),
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
