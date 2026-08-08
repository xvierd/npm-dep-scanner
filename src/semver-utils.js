import semver from 'semver';

/**
 * Classify a set of version strings (exact versions and/or ranges) for the
 * same package across projects.
 *
 * @param {string[]} values — versions/ranges declared or installed
 * @returns {'match' | 'compatible' | 'mismatch'}
 *   - match: every value is identical
 *   - compatible: values differ as strings but are semver-compatible
 *     (every pair intersects, or an exact version satisfies a range)
 *   - mismatch: at least one pair is incompatible
 *
 * Non-semver values (`workspace:*`, `file:`, `latest`, git URLs, …) are opaque:
 * they are only compatible with an identical string.
 */
export function classifyRow(values) {
  const vals = values.filter((v) => typeof v === 'string' && v !== '');
  if (vals.length <= 1) return 'match';
  if (new Set(vals).size === 1) return 'match';

  for (let i = 0; i < vals.length; i++) {
    for (let j = i + 1; j < vals.length; j++) {
      if (!pairCompatible(vals[i], vals[j])) return 'mismatch';
    }
  }
  return 'compatible';
}

function pairCompatible(a, b) {
  if (a === b) return true;
  if (isOpaque(a) || isOpaque(b)) return false;

  const exactA = semver.valid(a);
  const exactB = semver.valid(b);

  try {
    if (exactA && exactB) return false; // different exact versions
    if (exactA) return semver.satisfies(exactA, b, { includePrerelease: true });
    if (exactB) return semver.satisfies(exactB, a, { includePrerelease: true });
    return semver.intersects(a, b, { includePrerelease: true });
  } catch {
    return false; // unparsable range — treat as incompatible
  }
}

// A value is opaque when it is neither an exact version nor a valid range.
function isOpaque(v) {
  return !semver.valid(v) && !semver.validRange(v);
}
