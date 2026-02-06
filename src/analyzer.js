/**
 * Build a dependency matrix from an array of project objects.
 *
 * @param {Array} projects  — project objects with `.pkg`
 * @param {Object} opts
 * @param {boolean} opts.includeDev       — also process devDependencies
 * @param {boolean} opts.mismatchesOnly   — only return rows where versions differ
 * @returns {{ dependencies: Matrix, devDependencies: Matrix | null, mismatches: string[] }}
 *
 * A Matrix is { packages: string[], projects: string[], rows: Map<string, Map<string, string>> }
 */
export function analyzeProjects(projects, { includeDev = false, mismatchesOnly = false } = {}) {
  const depMatrix = buildMatrix(projects, 'dependencies');
  let devMatrix = null;
  if (includeDev) {
    devMatrix = buildMatrix(projects, 'devDependencies');
  }

  const allMismatches = [
    ...findMismatches(depMatrix),
    ...(devMatrix ? findMismatches(devMatrix) : []),
  ];

  if (mismatchesOnly) {
    filterToMismatches(depMatrix);
    if (devMatrix) filterToMismatches(devMatrix);
  }

  return { dependencies: depMatrix, devDependencies: devMatrix, mismatches: [...new Set(allMismatches)] };
}

function buildMatrix(projects, field) {
  const projectNames = projects.map((p) => p.name);
  // rows: packageName -> Map(projectName -> version)
  const rows = new Map();

  for (const project of projects) {
    const deps = project.pkg[field];
    if (!deps || typeof deps !== 'object') continue;

    for (const [pkg, version] of Object.entries(deps)) {
      if (!rows.has(pkg)) rows.set(pkg, new Map());
      rows.get(pkg).set(project.name, version);
    }
  }

  // Sort rows alphabetically
  const sorted = new Map([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return { packages: [...sorted.keys()], projects: projectNames, rows: sorted };
}

function findMismatches(matrix) {
  const mismatches = [];
  for (const [pkg, versions] of matrix.rows) {
    const unique = new Set(versions.values());
    if (unique.size > 1) mismatches.push(pkg);
  }
  return mismatches;
}

function filterToMismatches(matrix) {
  const toRemove = [];
  for (const [pkg, versions] of matrix.rows) {
    const unique = new Set(versions.values());
    if (unique.size <= 1) toRemove.push(pkg);
  }
  for (const pkg of toRemove) {
    matrix.rows.delete(pkg);
  }
  matrix.packages = [...matrix.rows.keys()];
}
