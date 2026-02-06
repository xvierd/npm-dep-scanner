#!/usr/bin/env node

import { resolve } from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';
import { scanProjects } from '../src/scanner.js';
import { selectProjects } from '../src/selector.js';
import { analyzeProjects } from '../src/analyzer.js';
import { report } from '../src/reporter.js';
import { printDiff } from '../src/differ.js';

const program = new Command();

program
  .name('npm-dep-scanner')
  .description('Scan a directory, detect Node.js projects, and compare dependency versions across them.')
  .version('1.0.0')
  .argument('[path]', 'directory to scan', '.')
  .option('-a, --all', 'skip interactive selection, scan all detected projects')
  .option('--dev', 'include devDependencies')
  .option('--json', 'output as JSON instead of a table')
  .option('-m, --mismatches-only', 'only show dependencies with version differences')
  .option('-d, --diff', 'show git-diff-style version differences between projects')
  .option('--depth <n>', 'max directory depth to scan (default: 10)', parseInt)
  .action(async (scanPath, opts) => {
    const rootDir = resolve(scanPath);

    if (!opts.json) {
      console.log(chalk.bold(`\n\uD83D\uDCE6 npm-dep-scanner \u2014 Scanning: ${scanPath}\n`));
    }

    const projects = await scanProjects(rootDir, { maxDepth: opts.depth || 10 });

    if (projects.length === 0) {
      if (!opts.json) {
        console.log(chalk.red('No Node.js projects found.'));
      }
      process.exit(1);
    }

    const selected = await selectProjects(projects, { skipSelection: !!opts.all });

    if (selected.length === 0) {
      if (!opts.json) {
        console.log(chalk.red('No projects selected.'));
      }
      process.exit(1);
    }

    if (!opts.json) {
      console.log(`Found ${projects.length} Node.js project${projects.length === 1 ? '' : 's'} (${selected.length} selected):`);
      for (const p of selected) {
        console.log(chalk.green(`  \u2714 ${p.name}`) + chalk.dim(` (${p.relativePath})`));
      }
      console.log();
    }

    const analysis = analyzeProjects(selected, {
      includeDev: !!opts.dev,
      mismatchesOnly: !!opts.mismatchesOnly,
    });

    // Determine the view mode
    let viewMode = opts.diff ? 'diff' : 'table';

    // In interactive mode (no --json, no --diff, no --all), ask the user
    if (!opts.json && !opts.diff && !opts.all) {
      const { mode } = await prompts({
        type: 'select',
        name: 'mode',
        message: 'How would you like to view the results?',
        choices: [
          { title: 'Comparison table', value: 'table', description: 'Side-by-side version matrix' },
          { title: 'Diff view', value: 'diff', description: 'Git-diff-style version differences' },
          { title: 'Both', value: 'both', description: 'Show table followed by diff' },
        ],
        initial: 0,
      });

      if (!mode) process.exit(0);
      viewMode = mode;
    }

    if (viewMode === 'table' || viewMode === 'both') {
      report(analysis, { json: !!opts.json });
    }

    if (viewMode === 'diff' || viewMode === 'both') {
      if (viewMode === 'both') console.log();
      console.log(chalk.bold('Diff:\n'));
      printDiff(analysis);
    }

    if (opts.json) {
      report(analysis, { json: true });
    }
  });

program.parse();
