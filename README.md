# npm-dep-scanner

**Are your Node.js projects using different versions of the same package?** Find out in seconds.

`npm-dep-scanner` scans a directory full of Node.js projects, compares their dependency versions side by side, and highlights the mismatches so you can fix them before they cause problems.

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
| `--diff` | `-d` | Jump straight to the diff view |
| `--mismatches-only` | `-m` | Hide dependencies that already match |
| `--json` | | Output as JSON (great for scripting) |
| `--help` | `-h` | Show help |
| `--version` | `-V` | Show version |

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

# Pipe to jq for scripting
npm-dep-scanner --all --json | jq '.mismatches'
```

---

## Full Interactive Example

```
$ npm-dep-scanner ~/projects

📦 npm-dep-scanner — Scanning: ~/projects

? Select projects to analyse ›
  ◯ api-service (./api-service)
  ◯ web-app (./web-app)
  ◯ shared-utils (./shared-utils)
  ↑/↓ to navigate, Space to toggle, Enter to submit

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

## License

MIT
