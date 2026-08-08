# npm-dep-scanner

**Are your Node.js projects using different versions of the same package?** Find out in seconds.

`npm-dep-scanner` scans a directory full of Node.js projects, compares their dependency versions side by side, and highlights the mismatches so you can fix them before they cause problems.

When a project has a lockfile (`package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`), the **installed** version is used instead of the declared range — so you compare what is actually on disk. Ranges that differ as strings but are semver-compatible are shown in green, not flagged as problems.

Perfect for monorepos, workspaces, or any folder with multiple Node.js projects.

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
│ axios    │ ^1.6.0       │ ^1.7.2   │ —            │
│ express  │ ^4.18.2      │ —        │ —            │
│ lodash   │ ^4.17.21     │ ^4.17.21 │ ^4.17.21     │
│ react    │ —            │ ^18.2.0  │ —            │
│ zod      │ ^3.22.0      │ ^3.21.0  │ ^3.22.0      │
└──────────┴──────────────┴──────────┴──────────────┘

⚠ 2 version mismatches found: axios, zod
```

### Diff View

Zero noise — only shows shared packages where versions actually differ:

```
api-service  vs  web-app
┌─────────┬─────────────┬─────────┐
│ Package │ api-service  │ web-app │
├─────────┼─────────────┼─────────┤
│ axios   │ ^1.6.0       │ ^1.7.2  │
│ zod     │ ^3.22.0      │ ^3.21.0 │
└─────────┴─────────────┴─────────┘

shared-utils  vs  web-app
┌─────────┬──────────────┬─────────┐
│ Package │ shared-utils │ web-app │
├─────────┼──────────────┼─────────┤
│ zod     │ ^3.22.0      │ ^3.21.0 │
└─────────┴──────────────┴─────────┘
```

---

## CLI Flags

| Flag | Short | What it does |
|------|-------|--------------|
| `--all` | `-a` | Skip project selection, scan everything |
| `--dev` | | Include devDependencies too |
| `--peer` | | Include peerDependencies |
| `--optional` | | Include optionalDependencies |
| `--all-deps` | | Include all dependency sets (prod, dev, peer, optional) |
| `--declared` | | Use declared ranges even when a lockfile exists |
| `--filter <pattern>` | | Only show packages matching a name or glob (e.g. `react-*`) |
| `--html <file>` | | Also write a self-contained HTML report |
| `--diff` | `-d` | Jump straight to the diff view |
| `--mismatches-only` | `-m` | Hide dependencies that already match |
| `--depth <n>` | | Max directory depth to scan (default: 10) |
| `--no-progress` | | Disable the scan progress spinner |
| `--json` | | Output as JSON (great for scripting) |
| `--help` | `-h` | Show help |
| `--version` | `-V` | Show version |

---

## Lockfiles

For each project, the tool looks for a lockfile next to its `package.json` and
prefers the **installed** version over the declared range:

| Lockfile | Notes |
|----------|-------|
| `package-lock.json` | lockfileVersion 1, 2 and 3 |
| `pnpm-lock.yaml` | v5/v6 (`packages`) and v9 (`importers`) |
| `yarn.lock` | classic (v1) and berry (v2+) |

Versions resolved from a lockfile are marked with `*` in the table and carry a
`source` field in JSON output. When several lockfiles coexist in one directory,
the precedence is `package-lock.json` → `pnpm-lock.yaml` → `yarn.lock`.
Use `--declared` to compare declared ranges instead.

## Version comparison

Each dependency row is classified with real semver semantics:

- **match** — identical versions everywhere
- **compatible** *(green)* — different strings, but semver-compatible
  (e.g. `^1.2.0` vs `~1.2.3`, or installed `1.6.8` vs declared `^1.6.0`)
- **mismatch** *(yellow)* — genuinely incompatible versions

Non-semver specs (`workspace:*`, `file:`, `latest`, git URLs) only match when identical.

## Workspaces

When the scanned directory is a workspace root (npm/yarn `workspaces` field or
`pnpm-workspace.yaml`), member packages are tagged `[workspace]` and come
pre-selected in the interactive picker.

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

# Compare declared ranges instead of installed versions
npm-dep-scanner --all --declared

# Deep scan for nested projects
npm-dep-scanner ~/big-project --depth 20

# Pipe to jq for scripting
npm-dep-scanner --all --json | jq '.mismatches'
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

? How would you like to view the results? ›
❯ Comparison table  — Side-by-side version matrix
  Diff view         — Pairwise version differences
  Both              — Show table followed by diff
```

---

## Requirements

- Node.js 18 or higher

## Development

```bash
npm install
npm test    # node:test unit tests for lockfile parsers, semver comparison and analyzer
```

## License

MIT
