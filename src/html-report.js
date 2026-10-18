import { writeFile } from 'node:fs/promises';

const SECTIONS = [
  ['dependencies', 'Dependencies'],
  ['devDependencies', 'Dev Dependencies'],
  ['peerDependencies', 'Peer Dependencies'],
  ['optionalDependencies', 'Optional Dependencies'],
];

/**
 * Write a self-contained HTML report of the analysis to `filePath`.
 */
export async function writeHtmlReport(analysis, filePath, { scannedPath = '.' } = {}) {
  const generatedAt = new Date().toISOString();

  const sections = SECTIONS
    .filter(([key]) => analysis[key] && analysis[key].packages.length > 0)
    .map(([key, title]) => renderSection(title, analysis[key], analysis.comparison ?? 'compatible'))
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>npm-dep-scanner report</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 2rem auto; max-width: 1100px; padding: 0 1rem; color: #1a1a2e; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  .meta { color: #666; font-size: .85rem; margin-bottom: 1.5rem; }
  .summary { margin: 1rem 0; padding: .75rem 1rem; border-radius: 6px; font-size: .9rem; }
  .summary.ok { background: #e8f7ee; color: #1c7c3c; }
  .summary.warn { background: #fdf3d8; color: #8a6d00; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { border: 1px solid #ddd; padding: .45rem .7rem; text-align: left; }
  th { background: #f4f4f7; }
  td { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  tr.mismatch td { background: #fdf3d8; }
  tr.compatible td { background: #e8f7ee; }
  tr.mismatch td:first-child { font-weight: 600; }
  .pkg { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .src { font-size: .72rem; color: #777; display: block; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .missing { color: #aaa; }
  .legend { font-size: .8rem; color: #666; margin-top: .4rem; }
  .badge { display: inline-block; padding: .1rem .45rem; border-radius: 4px; font-size: .72rem; margin-left: .4rem; }
  .badge.mismatch { background: #f6e05e; color: #5c4400; }
  .badge.compatible { background: #c6f6d5; color: #22543d; }
</style>
</head>
<body>
<h1>npm-dep-scanner report</h1>
<p class="meta">Scanned: ${esc(scannedPath)} &middot; Comparison: ${esc(analysis.comparison ?? 'compatible')} &middot; Generated: ${esc(generatedAt)}</p>
${renderSummary(analysis)}
${sections}
</body>
</html>
`;

  await writeFile(filePath, html, 'utf-8');
}

function renderSummary(analysis) {
  const parts = [];
  if (analysis.mismatches.length > 0) {
    parts.push(
      `<div class="summary warn">&#9888; ${analysis.mismatches.length} version mismatch${analysis.mismatches.length === 1 ? '' : 'es'} found: ${esc(analysis.mismatches.join(', '))}</div>`
    );
  } else {
    parts.push('<div class="summary ok">&#10004; All dependency versions are consistent across projects.</div>');
  }
  if (analysis.compatible.length > 0) {
    parts.push(
      `<div class="summary ok">&#8776; ${analysis.compatible.length} package${analysis.compatible.length === 1 ? '' : 's'} with different but compatible ranges: ${esc(analysis.compatible.join(', '))}</div>`
    );
  }
  return parts.join('\n');
}

function renderSection(title, matrix, comparison) {
  const head = ['Package', ...matrix.projects.map((p) => matrix.projectLabels.get(p))]
    .map((h) => `<th>${esc(h)}</th>`).join('');

  const rows = matrix.packages
    .map((pkg) => {
      const status = matrix.status.get(pkg);
      const versions = matrix.rows.get(pkg);
      const badge =
        status === 'mismatch'
          ? '<span class="badge mismatch">mismatch</span>'
          : status === 'compatible'
            ? '<span class="badge compatible">compatible</span>'
            : '';

      const cells = matrix.projects
        .map((proj) => {
          const cell = versions.get(proj);
          if (!cell) return '<td class="missing">&mdash;</td>';
          const src = cell.source !== 'package.json' ? `<span class="src">${esc(cell.source)}</span>` : '';
          return `<td>${esc(cell.version)}${src}</td>`;
        })
        .join('');

      return `<tr class="${status}"><td class="pkg">${esc(pkg)}${badge}</td>${cells}</tr>`;
    })
    .join('\n');

  return `<h2>${esc(title)}</h2>
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="legend">${comparison === 'exact'
    ? 'Yellow = different version strings'
    : 'Yellow = version mismatch &middot; green = different ranges with a common version'} &middot; lockfile source shown under each resolved version.</p>`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
