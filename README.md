# npm-dep-scanner

**Are your Node.js projects using different versions of the same package?** Find out in seconds.

`npm-dep-scanner` scans a directory full of Node.js projects, compares their dependency versions side by side, and highlights the mismatches so you can fix them before they cause problems.

When a project has a lockfile (`package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`), the **resolved version recorded in the lockfile** is used instead of the declared range. Workspace members can use their shared root lockfile. The scanner does not inspect `node_modules`. Ranges that differ as strings but are semver-compatible are shown in green, not flagged as problems.

Perfect for monorepos, workspaces, or any folder with multiple Node.js projects.

## Version 1.3.0

- Noninteractive `--check` mode for CI, with separate exit codes for policy violations and errors.
- Shared JSON configuration for exclusions, dependency sets and comparison policies.
- Deterministic JSON report v1, with relative project IDs and a published schema.
- Context-aware npm, pnpm and Yarn lockfile resolution, including shared workspace locks.
- Bounded pattern matching and removal of the vulnerable `braces` dependency chain.

---

## Get Started in 30 Seconds

No install needed — just run it:

```bash
npx npm-dep-scanner ~/my-projects
```

That's it. Pick your projects, choose a view, and see the results.

---

## Install (optional)

If you use it often, install it globally:

```bash
npm install -g npm-dep-scanner
```

Then just run:

```bash
npm-dep-scanner
```

For a shared project or CI pipeline, install the version locally and commit the
updated manifest and lockfile:

```bash
npm install --save-dev --save-exact npm-dep-scanner@1.3.0
npx npm-dep-scanner . --check --json
```

---

## How It Works

```
1. Point it at a folder     ──>  It finds all Node.js projects
2. Pick the ones you want   ──>  Interactive checkbox list
3. Choose a view            ──>  Table, Diff, or Both
4. See the results          ──>  Color-coded, mismatches highlighted
```

### Comparison Table

See every dependency across every project at a glance:

```
Dependencies:
┌──────────┬──────────────┬──────────┬──────────────┐
│ Package  │ api-service  │ web-app  │ shared-utils │
├──────────┼──────────────┼──────────┼──────────────┤
│ axios    │ 1.6.0        │ 1.7.2    │ —            │
│ express  │ ^4.18.2      │ —        │ —            │
│ lodash   │ ^4.17.21     │ ^4.17.21 │ ^4.17.21     │
│ react    │ —            │ ^18.2.0  │ —            │
│ zod      │ 3.22.0       │ 3.21.0   │ 3.22.0       │
└──────────┴──────────────┴──────────┴──────────────┘

⚠ 2 version mismatches found: axios, zod
```

### Diff View

Zero noise — only shows shared packages where versions actually differ:

```
api-service  vs  web-app
┌──────────────┬─────────┬─────────────┬─────────┐
│ Section      │ Package │ api-service │ web-app │
├──────────────┼─────────┼─────────────┼─────────┤
│ dependencies │ axios   │ 1.6.0       │ 1.7.2   │
├──────────────┼─────────┼─────────────┼─────────┤
│ dependencies │ zod     │ 3.22.0      │ 3.21.0  │
└──────────────┴─────────┴─────────────┴─────────┘

web-app  vs  shared-utils
┌──────────────┬─────────┬─────────┬──────────────┐
│ Section      │ Package │ web-app │ shared-utils │
├──────────────┼─────────┼─────────┼──────────────┤
│ dependencies │ zod     │ 3.21.0  │ 3.22.0       │
└──────────────┴─────────┴─────────┴──────────────┘
```

---

## CLI Flags

| Flag | Short | What it does |
|------|-------|--------------|
| `--all` | `-a` | Skip all prompts; scan every project allowed by the configured scope |
| `--dev` | | Include devDependencies too |
| `--peer` | | Include peerDependencies |
| `--optional` | | Include optionalDependencies |
| `--all-deps` | | Include all dependency sets (prod, dev, peer, optional) |
| `--declared` | | Use declared ranges even when a lockfile exists |
| `--version-source <source>` | | `resolved` (default) or `declared`; overrides configuration |
| `--check` | | Noninteractive CI check; exit 1 on policy violations, 2 on errors |
| `--config <file>` | | Read an explicit JSON configuration file |
| `--no-config` | | Disable configuration discovery |
| `--comparison <policy>` | | `compatible` (default) or `exact` |
| `--only <sets>` | | Compare only `prod,dev,peer,optional` (comma-separated) |
| `--exclude <pattern>` | | Exclude directories or project manifests; repeatable |
| `--ignore-package <pattern>` | | Exclude matching dependency names; repeatable |
| `--filter <pattern>` | | Case-insensitive name substring, or full-name wildcard using `*`/`?` (e.g. `react-*`) |
| `--html <file>` | | Also write a self-contained HTML report |
| `--diff` | `-d` | Jump straight to the diff view |
| `--mismatches-only` | `-m` | Show only policy violations; hide matching and compatible rows |
| `--depth <n>` | | Directory depth from 0 to 100 (default: 10); 0 scans only the root |
| `--no-progress` | | Disable the scan progress spinner |
| `--json` | | Output deterministic JSON using report schema v1; never prompt |
| `--help` | `-h` | Show help |
| `--version` | `-V` | Show version |

---

## Lockfiles

For each project, the tool looks for a lockfile next to its `package.json`, then
uses the nearest workspace root's lockfile if the project is a member and has no
local lockfile. It prefers the **resolved** version over the declared range:

| Lockfile | Notes |
|----------|-------|
| `package-lock.json` | lockfileVersion 1, 2 and 3 |
| `pnpm-lock.yaml` | v5/v6 (`packages`) and v9 (`importers`) |
| `yarn.lock` | classic (v1) and berry (v2+) |

Versions resolved from a lockfile are marked with `*` in the table and carry a
`source` field in JSON output. When several lockfiles coexist in one directory,
the precedence is `package-lock.json` → `pnpm-lock.yaml` → `yarn.lock`.
Use `--declared` to compare declared ranges instead.

Resolution uses the dependency's context: npm's package location and hoisting,
pnpm's importer, or Yarn's package name and declared descriptor. An unrelated
transitive version is never used as a substitute. Unresolved or ambiguous entries
fall back to the declaration, with `source: "package.json"` and `resolved: null`.
Peer dependencies always retain their declared ranges because they describe a
consumer compatibility contract.

Invalid manifests stop the scan with exit code 2. In resolved mode, unreadable or
malformed lockfiles also stop the scan. `--declared` (or `versionSource: "declared"`)
does not read lockfiles, so their errors do not affect declared-range comparisons.

JSON cells include `version`, `source`, `declared` and `resolved` (the lockfile
version or `null`). Project identity is based on its path, so duplicate names
cannot overwrite a result. Human-readable reports disambiguate equal names with
paths; the JSON contract below uses relative project IDs.

## Version comparison

Each dependency row is classified with real semver semantics:

- **match** — identical versions everywhere
- **compatible** *(green)* — different strings with at least one version that satisfies every range
  (e.g. `^1.2.0` vs `~1.2.3`, or resolved `1.6.8` vs declared `^1.6.0`)
- **mismatch** *(yellow)* — no shared version, or any differing strings under `exact`

Non-semver specs (`workspace:*`, `file:`, `latest`, git URLs) only match when identical.
Prereleases must be explicitly admitted by the range, following npm semver defaults.
Pairwise overlap is insufficient: `1 || 2`, `2 || 3` and `1 || 3` fail because no
version satisfies all three. Distinct resolved versions are mismatches.
`--comparison exact` requires identical version strings, including range syntax.
Packages absent from a project are shown as `null`/`—`; absence is not a violation.

## CI and shared configuration

```bash
npm-dep-scanner . --check --json > dependency-report.json
```

`--check` scans all discovered projects without prompts or a spinner. Exit codes:

| Code | Meaning |
|------|---------|
| `0` | The selected dependencies satisfy the comparison policy |
| `1` | At least one dependency violates the policy (`--check` only) |
| `2` | Invalid options/configuration, read/parse failure, unsafe patterns or no projects |

Without `--check`, a completed report exits 0 even when it contains mismatches.
Filters, exclusions and selected dependency sets define the scope of the check.
Excluding every project is an error; projects with no included dependencies pass.

Commit a `.npm-dep-scanner.json` beside your root `package.json` to share policy.
The optional `$schema` below assumes a local installation; omit it when using
only a global installation or `npx` without installing the package locally:

```json
{
  "$schema": "./node_modules/npm-dep-scanner/schemas/config.schema.json",
  "schemaVersion": 1,
  "exclude": ["fixtures/**", "examples/legacy"],
  "ignorePackages": ["@internal/*"],
  "comparison": "compatible",
  "dependencyTypes": ["dependencies", "devDependencies"],
  "versionSource": "resolved",
  "maxDepth": 10
}
```

Discovery starts at the real scan directory and searches its ancestors for the
nearest config, stopping after checking the repository's `.git` boundary. There
is no config inheritance or merge between files. `--config <file>` selects one
file relative to the current working directory; it cannot be combined with
`--no-config`. Configuration is JSON only; `$schema` is editor metadata and is
never fetched or executed. Unknown keys and invalid values are errors.

Defaults are production dependencies, `compatible`, `resolved`, depth 10 and no
exclusions. CLI scalar values override configuration. `--only` replaces configured
dependency sets; `--dev`, `--peer`, `--optional` and `--all-deps` add sets. Repeated
`--exclude` and `--ignore-package` append to configured lists.

Exclusion paths use `/` and are relative to the config directory, or the scan root
when no config is loaded. Excluding a directory prunes its descendants before
reading them. Patterns can also match a `package.json`; excluding that manifest
disables its workspace configuration and shared lockfile. Other individual files
are not exclusion targets. Hidden directories, `node_modules`, `dist`, `build`
and child symlinks are skipped automatically. Exclusion lists do not support
`!pattern` reinclusion. `ignorePackages` matches full dependency names, including
scopes (for example `@internal/*`).

`--filter` is a separate, simpler name filter: plain text matches a substring,
and patterns containing `*` or `?` match the whole name, case-insensitively.
Braces, character classes and extglobs have no special meaning in this option.

## JSON report v1

The published [report schema](schemas/report.schema.json) describes success,
mismatch and error reports. All reports have `schemaVersion: 1`, `status`,
`comparison`, `projects`, four dependency maps, `mismatches`, `compatible`,
`summary` and `errors`. Disabled dependency sets are `null`; enabled empty sets
are `{}`. Each package row contains `status` and a `versions` map:

```json
{
  "status": "compatible",
  "versions": {
    "packages/api": {
      "version": "^1.0.0",
      "declared": "^1.0.0",
      "resolved": null,
      "source": "package.json"
    },
    "packages/web": {
      "version": "~1.0.0",
      "declared": "~1.0.0",
      "resolved": null,
      "source": "package.json"
    }
  }
}
```

Projects are `{ "id": "packages/api", "path": "packages/api", "name": "api" }`;
the root's ID is `.`. IDs, package keys and summary name lists are ordered
deterministically. Completed reports contain no timestamps or absolute checkout
paths, so relocating the same tree produces the same JSON. Summary counts use
unique package names across the visible sections. Error reports keep the same
top-level shape with `status: "error"` and `errors: [{ "code", "message" }]`;
diagnostic messages may include local paths. Stdout is JSON only; human-readable
errors go to stderr.

## Workspaces

Workspace roots are detected from npm/yarn's `workspaces` field or
`pnpm-workspace.yaml`, including roots nested below the scan directory. Scans
started inside a workspace inspect ancestor configuration without scanning sibling
projects. Member packages are tagged `[workspace]` and come pre-selected in the
interactive picker. Negative patterns such as `!packages/legacy` are respected;
excluded packages can still be scanned as independent projects.

Workspace patterns are validated before glob processing: at most 128 patterns,
1,024 characters per pattern, 8 levels of nesting and 4,096 combined potential
expansions. Malformed or excessively complex patterns are rejected with a clear
error. Parsing and matching also run in an isolated worker with a 1,500 ms deadline;
over-budget matching is terminated so even short patterns cannot hang the CLI
through regex backtracking. Shared exclusions and package-ignore patterns use
the same safeguards. Matching uses `picomatch` with raw regex syntax disabled;
`fast-glob`, `micromatch` and the vulnerable `braces` dependency have been removed.
The simpler `--filter` wildcard matcher does not construct regular expressions.

---

## Common Recipes

```bash
# Scan current directory interactively
npm-dep-scanner

# Scan everything, no prompts
npm-dep-scanner --all

# Show only the problems
npm-dep-scanner --all --mismatches-only

# Diff view including devDependencies
npm-dep-scanner --all --dev --diff

# Compare every dependency set
npm-dep-scanner --all --all-deps

# Only react-related packages, plus an HTML report
npm-dep-scanner --all --filter 'react-*' --html report.html

# Compare declared ranges instead of lockfile resolutions
npm-dep-scanner --all --declared

# Deep scan for nested projects
npm-dep-scanner ~/big-project --depth 20

# Pipe to jq for scripting
npm-dep-scanner --all --json | jq '.mismatches'

# Enforce identical declared devDependency specs in CI
npm-dep-scanner --check --only dev --declared --comparison exact
```

---

## Full Interactive Example

```
$ npm-dep-scanner ~/projects

📦 npm-dep-scanner — Scanning: ~/projects

? Select projects to analyse (type to search) ›
  ◯ api-service (./api-service)
  ◯ web-app (./web-app)
  ◯ shared-utils (./shared-utils)
  ↑/↓ to navigate, type to filter, Space to toggle, Enter to submit

Found 3 Node.js projects (3 selected):
  ✔ api-service (./api-service)
  ✔ web-app (./web-app)
  ✔ shared-utils (./shared-utils)

? Which dependency sets do you want to compare? ›
  ◉ dependencies
  ◯ devDependencies
  ◯ peerDependencies
  ◯ optionalDependencies

? How would you like to view the results? ›
❯ Comparison table
  Diff view
  Both
```

The dependency-set prompt appears when no configuration file or dependency-set
flags are supplied. `--all`, `--check`, `--json`, or streams without a terminal
disable interactive prompts.

---

## Requirements

- Node.js 22 or higher (CI tests Node.js 22 and 24)

## Development

```bash
npm install
npm test    # parser, workspace, analyzer, reporter and CLI regression tests
npm audit   # check for known dependency vulnerabilities
```

Pull requests and releases run the tests and `npm audit --audit-level=low`.
The current lockfile audited with zero known vulnerabilities on 2026-10-18.

## License

MIT
