import Table from 'cli-table3';
import chalk from 'chalk';

/**
 * Print the analysis results as a coloured table or as JSON.
 */
export function report({ dependencies, devDependencies, mismatches }, { json = false } = {}) {
  if (json) {
    return reportJson({ dependencies, devDependencies, mismatches });
  }

  printTable('Dependencies', dependencies, mismatches);

  if (devDependencies && devDependencies.packages.length > 0) {
    console.log();
    printTable('Dev Dependencies', devDependencies, mismatches);
  }

  console.log();
  if (mismatches.length > 0) {
    console.log(
      chalk.yellow(`\u26A0 ${mismatches.length} version mismatch${mismatches.length === 1 ? '' : 'es'} found: ${mismatches.join(', ')}`)
    );
  } else {
    console.log(chalk.green('\u2714 All dependency versions are consistent across projects.'));
  }
}

function printTable(title, matrix, mismatches) {
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
    const isMismatch = mismatches.includes(pkg);

    const row = [isMismatch ? chalk.yellow(pkg) : pkg];

    for (const proj of matrix.projects) {
      const ver = versions.get(proj);
      if (!ver) {
        row.push(chalk.dim('\u2014'));
      } else if (isMismatch) {
        row.push(chalk.yellow(ver));
      } else {
        row.push(ver);
      }
    }

    table.push(row);
  }

  console.log(table.toString());
}

function reportJson({ dependencies, devDependencies, mismatches }) {
  const serialiseMatrix = (m) => {
    if (!m) return null;
    const obj = {};
    for (const [pkg, versions] of m.rows) {
      obj[pkg] = {};
      for (const proj of m.projects) {
        obj[pkg][proj] = versions.get(proj) ?? null;
      }
    }
    return obj;
  };

  const output = {
    dependencies: serialiseMatrix(dependencies),
    mismatches,
  };

  if (devDependencies) {
    output.devDependencies = serialiseMatrix(devDependencies);
  }

  console.log(JSON.stringify(output, null, 2));
}
