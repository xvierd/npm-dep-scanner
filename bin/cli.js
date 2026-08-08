#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { scanProjects } from '../src/scanner.js';
import { markWorkspaceMembers } from '../src/workspaces.js';
import { selectProjects } from '../src/selector.js';
import { analyzeProjects } from '../src/analyzer.js';
import { report } from '../src/reporter.js';
import { printDiff } from '../src/differ.js';
import { writeHtmlReport } from '../src/html-report.js';
import { makeFilter } from '../src/utils.js';

const here = dirname(fileURLToPath(import.meta.url));
const ownPkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('npm-dep-scanner')
  .description('Scan a directory, detect Node.js projects, and compare dependency versions across them.')
  .version(ownPkg.version)
  .argument('[path]', 'directory to scan', '.')
  .option('-a, --all', 'skip interactive selection, scan all detected projects')
  .option('--dev', 'include devDependencies')
  .option('--peer', 'include peerDependencies')
  .option('--optional', 'include optionalDependencies')
  .option('--all-deps', 'include dependencies, devDependencies, peerDependencies and optionalDependencies')
  .option('--declared', 'use declared ranges from package.json even when a lockfile exists')
  .option('--filter <pattern>', 'only show packages matching a name or glob pattern')
  .option('--html <file>', 'also write a self-contained HTML report')
  .option('--json', 'output as JSON instead of a table')
  .option('-m, --mismatches-only', 'only show dependencies with version differences')
  .option('-d, --diff', 'show git-diff-style version differences between projects')
  .option('--depth <n>', 'max directory depth to scan (default: 10)', parseInt)
  .option('--no-progress', 'disable the scan progress spinner')
  .action(async (scanPath, opts) => {
    const rootDir = resolve(scanPath);
    const interactive = !opts.json && !opts.all;

    if (!opts.json) {
      console.log(chalk.bold(`\n📦 npm-dep-scanner — Scanning: ${scanPath}\n`));
    }

    const showSpinner = !opts.json && opts.progress !== false && process.stdout.isTTY;
    const spinner = showSpinner ? ora('Scanning for package.json files…').start() : null;

    const projects = await scanProjects(rootDir, {
      maxDepth: opts.depth || 10,
      onProgress: spinner
        ? (n) => {
            spinner.text = `Scanning… ${n} project${n === 1 ? '' : 's'} found`;
          }
        : null,
    });

    if (spinner) {
      if (projects.length > 0) {
        spinner.succeed(`Found ${projects.length} Node.js project${projects.length === 1 ? '' : 's'}`);
      } else {
        spinner.stop();
      }
    }

    if (projects.length === 0) {
      if (!opts.json) {
        console.log(chalk.red('No Node.js projects found.'));
      }
      process.exit(1);
    }

    const workspace = await markWorkspaceMembers(rootDir, projects);
    if (workspace.isWorkspace && !opts.json) {
      console.log(chalk.dim(`Workspace root detected (${workspace.patterns.join(', ')})`));
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
        const tags = [
          p.isWorkspaceMember ? 'workspace' : null,
          p.lockfile && !opts.declared ? p.lockfile.type : null,
        ].filter(Boolean);
        console.log(
          chalk.green(`  ✔ ${p.name}`) +
            chalk.dim(` (${p.relativePath})`) +
            (tags.length ? chalk.dim(` [${tags.join(', ')}]`) : '')
        );
      }
      console.log();
    }

    // Which dependency sets to include
    let includeDev = !!opts.dev;
    let includePeer = !!opts.peer;
    let includeOptional = !!opts.optional;
    if (opts.allDeps) {
      includeDev = includePeer = includeOptional = true;
    }

    // In interactive mode, ask when no dependency-set flag was given
    if (interactive && !opts.dev && !opts.peer && !opts.optional && !opts.allDeps) {
      const { sets } = await prompts({
        type: 'multiselect',
        name: 'sets',
        message: 'Which dependency sets do you want to compare?',
        choices: [
          { title: 'dependencies', value: 'prod', selected: true },
          { title: 'devDependencies', value: 'dev', selected: false },
          { title: 'peerDependencies', value: 'peer', selected: false },
          { title: 'optionalDependencies', value: 'optional', selected: false },
        ],
        hint: '- Space to toggle, Enter to submit',
        instructions: false,
      });

      if (!sets) process.exit(0);
      includeDev = sets.includes('dev');
      includePeer = sets.includes('peer');
      includeOptional = sets.includes('optional');
    }

    const analysis = analyzeProjects(selected, {
      includeDev,
      includePeer,
      includeOptional,
      mismatchesOnly: !!opts.mismatchesOnly,
      useDeclared: !!opts.declared,
      filter: makeFilter(opts.filter),
    });

    if (opts.html) {
      const htmlPath = resolve(opts.html);
      await writeHtmlReport(analysis, htmlPath, { scannedPath: rootDir });
      if (!opts.json) {
        console.log(chalk.green(`✔ HTML report written to ${htmlPath}\n`));
      }
    }

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

    if (!opts.json && (viewMode === 'table' || viewMode === 'both')) {
      report(analysis);
    }

    if (!opts.json && (viewMode === 'diff' || viewMode === 'both')) {
      if (viewMode === 'both') console.log();
      console.log(chalk.bold('Diff:\n'));
      printDiff(analysis);
    }

    if (opts.json) {
      report(analysis, { json: true });
    }
  });

program.parse();
