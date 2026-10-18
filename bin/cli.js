#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import prompts from 'prompts';
import { scanProjects } from '../src/scanner.js';
import { selectProjects } from '../src/selector.js';
import { analyzeProjects } from '../src/analyzer.js';
import { report, errorJsonReport } from '../src/reporter.js';
import { printDiff } from '../src/differ.js';
import { writeHtmlReport } from '../src/html-report.js';
import { makeFilter } from '../src/utils.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { matchPatterns } from '../src/patterns.js';

const here = dirname(fileURLToPath(import.meta.url));
const ownPkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf-8'));
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const aliases = { prod: 'dependencies', dev: 'devDependencies', peer: 'peerDependencies', optional: 'optionalDependencies' };
const program = new Command();
let comparison = 'compatible';
const configOptions = {};

function depth(value) {
  if (!/^\d+$/.test(value) || Number(value) > 100) {
    throw new InvalidArgumentError('depth must be an integer from 0 to 100');
  }
  return Number(value);
}

function sections(value) {
  const fields = value.split(',').map((field) => aliases[field.trim()] ?? field.trim());
  if (!fields.length || fields.some((field) => !dependencyFields.includes(field))) {
    throw new InvalidArgumentError('use prod,dev,peer,optional separated by commas');
  }
  return [...new Set(fields)];
}

const append = (value, previous = []) => [...previous, value];
const failure = (message, code) => Object.assign(new Error(message), { code });

program
  .name('npm-dep-scanner')
  .description('Scan Node.js projects and compare dependency versions locally or in CI.')
  .version(ownPkg.version)
  .argument('[path]', 'directory to scan', '.')
  .option('-a, --all', 'skip interactive selection, scan all detected projects')
  .option('--check', 'CI mode: exit 0 for compliance, 1 for differences, 2 for errors')
  .option('--config <file>', 'use a shared JSON configuration file')
  .option('--no-config', 'disable automatic configuration discovery')
  .option('--exclude <pattern>', 'exclude a project path or directory (repeatable)', append)
  .option('--ignore-package <pattern>', 'exclude matching dependency names (repeatable)', append)
  .option('--comparison <policy>', 'comparison policy: compatible or exact')
  .option('--only <sets>', 'dependency sets: prod,dev,peer,optional (comma-separated)', sections)
  .option('--dev', 'include devDependencies')
  .option('--peer', 'include peerDependencies')
  .option('--optional', 'include optionalDependencies')
  .option('--all-deps', 'include all dependency sets')
  .option('--declared', 'use declared ranges instead of lockfile resolutions')
  .option('--version-source <source>', 'version source: resolved or declared')
  .option('--filter <pattern>', 'only show packages matching a name or wildcard (* or ?)')
  .option('--html <file>', 'also write a self-contained HTML report')
  .option('--json', 'output the versioned JSON report')
  .option('-m, --mismatches-only', 'only show dependencies that violate the comparison policy')
  .option('-d, --diff', 'show dependency differences between project pairs')
  .option('--depth <n>', 'maximum directory depth, 0 scans only the root (default: 10)', depth)
  .option('--no-progress', 'disable the scan progress spinner')
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  // Commander stores --config and --no-config under the same option key.
  // Retain both occurrences so contradictory flags cannot silently override.
  .on('option:config', (file) => { configOptions.configFile = file; })
  .on('option:no-config', () => { configOptions.enabled = false; })
  .action(async (scanPath, opts) => {
    const rootDir = resolve(scanPath);
    if (opts.declared && opts.versionSource && opts.versionSource !== 'declared') {
      throw failure('--declared conflicts with --version-source resolved', 'CLI_ERROR');
    }
    const loaded = await loadConfig(rootDir, configOptions);
    const types = new Set(opts.only ?? loaded.config.dependencyTypes);
    if (opts.dev) types.add('devDependencies');
    if (opts.peer) types.add('peerDependencies');
    if (opts.optional) types.add('optionalDependencies');
    if (opts.allDeps) dependencyFields.forEach((field) => types.add(field));
    const config = validateConfig({
      ...loaded.config,
      comparison: opts.comparison ?? loaded.config.comparison,
      dependencyTypes: [...types],
      exclude: [...new Set([...loaded.config.exclude, ...(opts.exclude ?? [])])],
      ignorePackages: [...new Set([...loaded.config.ignorePackages, ...(opts.ignorePackage ?? [])])],
      versionSource: opts.declared ? 'declared' : opts.versionSource ?? loaded.config.versionSource,
      maxDepth: opts.depth ?? loaded.config.maxDepth,
    });
    comparison = config.comparison;
    // Validate even when there are no dependencies, before performing a scan.
    const nameFilter = makeFilter(opts.filter);
    const interactive = !opts.check && !opts.json && !opts.all && !!process.stdin.isTTY && !!process.stdout.isTTY;

    if (!opts.json) console.log(chalk.bold(`\n📦 npm-dep-scanner — Scanning: ${scanPath}\n`));
    const showSpinner = !opts.check && !opts.json && opts.progress !== false && process.stdout.isTTY;
    const spinner = showSpinner ? ora('Scanning for package.json files…').start() : null;
    let projects;
    try {
      projects = await scanProjects(rootDir, {
        maxDepth: config.maxDepth,
        useDeclared: config.versionSource === 'declared',
        exclude: config.exclude,
        excludeBaseDir: loaded.baseDir,
        onProgress: spinner ? (count) => { spinner.text = `Scanning… ${count} projects found`; } : null,
      });
    } finally {
      spinner?.stop();
    }
    if (projects.length === 0) throw failure('No Node.js projects found after exclusions.', 'NO_PROJECTS');
    const selected = await selectProjects(projects, { skipSelection: !interactive });
    if (selected.length === 0) throw failure('No projects selected.', 'NO_PROJECTS');

    if (!opts.json) {
      console.log(`Found ${projects.length} Node.js projects (${selected.length} selected):`);
      for (const project of selected) {
        const tags = [project.isWorkspaceMember ? 'workspace' : null,
          project.lockfile && config.versionSource !== 'declared' ? project.lockfile.type : null].filter(Boolean);
        console.log(chalk.green(`  ✔ ${project.name}`) + chalk.dim(` (${project.relativePath})`)
          + (tags.length ? chalk.dim(` [${tags.join(', ')}]`) : ''));
      }
      console.log();
    }

    let fields = config.dependencyTypes;
    if (interactive && !loaded.path && !opts.only && !opts.dev && !opts.peer && !opts.optional && !opts.allDeps) {
      const { sets } = await prompts({
        type: 'multiselect', name: 'sets', message: 'Which dependency sets do you want to compare?',
        choices: dependencyFields.map((field) => ({ title: field, value: field, selected: fields.includes(field) })),
        hint: '- Space to toggle, Enter to submit', instructions: false,
      });
      if (!sets) return;
      if (sets.length === 0) throw failure('Select at least one dependency set.', 'CLI_ERROR');
      fields = sets;
    }

    const packageNames = [...new Set(selected.flatMap((project) =>
      fields.flatMap((field) => Object.keys(project.pkg[field] ?? {}))))];
    const ignored = new Set(await matchPatterns(packageNames, config.ignorePackages, {
      label: 'package exclusion patterns', dot: true,
    }));
    const analysis = analyzeProjects(selected, {
      includeProd: fields.includes('dependencies'),
      includeDev: fields.includes('devDependencies'),
      includePeer: fields.includes('peerDependencies'),
      includeOptional: fields.includes('optionalDependencies'),
      comparison,
      mismatchesOnly: !!opts.mismatchesOnly,
      useDeclared: config.versionSource === 'declared',
      filter: (name) => !ignored.has(name) && (!nameFilter || nameFilter(name)),
    });

    if (opts.html) {
      const htmlPath = resolve(opts.html);
      await writeHtmlReport(analysis, htmlPath, { scannedPath: rootDir });
      if (!opts.json) console.log(chalk.green(`✔ HTML report written to ${htmlPath}\n`));
    }

    let viewMode = opts.diff ? 'diff' : 'table';
    if (interactive && !opts.diff) {
      const { mode } = await prompts({
        type: 'select', name: 'mode', message: 'How would you like to view the results?',
        choices: [{ title: 'Comparison table', value: 'table' }, { title: 'Diff view', value: 'diff' },
          { title: 'Both', value: 'both' }], initial: 0,
      });
      if (!mode) return;
      viewMode = mode;
    }
    if (opts.json) report(analysis, { json: true });
    else {
      if (viewMode === 'table' || viewMode === 'both') report(analysis);
      if (viewMode === 'diff' || viewMode === 'both') printDiff(analysis);
    }
    if (opts.check && analysis.mismatches.length > 0) process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (error) {
  if (!['commander.helpDisplayed', 'commander.version'].includes(error.code)) {
    const code = error.code?.startsWith('commander.') ? 'CLI_ERROR'
      : ['CONFIG_ERROR', 'CLI_ERROR', 'NO_PROJECTS'].includes(error.code) ? error.code : 'SCAN_ERROR';
    if (process.argv.slice(2).includes('--json')) {
      console.log(JSON.stringify(errorJsonReport(error, { comparison, code }), null, 2));
    }
    console.error(`npm-dep-scanner: ${error.message}`);
    process.exitCode = 2;
  }
}
