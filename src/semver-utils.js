import semver from 'semver';

export function validateComparison(comparison) {
  if (comparison !== 'compatible' && comparison !== 'exact') {
    throw new Error(`Invalid comparison policy: ${comparison}. Expected compatible or exact.`);
  }
}

/**
 * Identical strings match. Exact policy treats any different strings as a
 * mismatch. Compatible policy requires a version that satisfies every range,
 * with npm's default prerelease rules. Opaque specs only match identical specs.
 */
export function classifyRow(values, comparison = 'compatible') {
  validateComparison(comparison);
  const vals = [...new Set(values.filter((value) => typeof value === 'string'))];
  if (vals.length <= 1) return 'match';
  if (comparison === 'exact') return 'mismatch';

  try {
    const ranges = vals.map((value) => new semver.Range(value));
    const exact = vals.filter((value) => semver.valid(value));
    // Distinct locked version strings continue to be different versions, even
    // when semver would ignore a build identifier or normalize a leading "v".
    if (exact.length > 1) return 'mismatch';
    if (exact.length === 1) {
      return ranges.every((range) => range.test(exact[0])) ? 'compatible' : 'mismatch';
    }
    return hasCommonVersion(ranges) ? 'compatible' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

function hasCommonVersion(ranges) {
  // Each comparator set is an interval. If intervals have a common stable
  // version, their least one is a boundary or the next stable version after an
  // open boundary. For prereleases, also consider the first value of each
  // explicitly admitted tuple and the successor of each open prerelease bound.
  // Testing against the original ranges preserves each one's prerelease rules
  // and avoids expanding the Cartesian product of their OR alternatives.
  const candidates = new Set(['0.0.0']);
  for (const range of ranges) {
    for (const comparators of range.set) {
      for (const comparator of comparators) {
        const version = comparator.semver;
        if (typeof version?.version !== 'string') continue; // wildcard
        const stable = `${version.major}.${version.minor}.${version.patch}`;
        candidates.add(version.version);
        candidates.add(stable);
        if (version.prerelease.length > 0) candidates.add(`${stable}-0`);
        if (comparator.operator === '>') {
          const next = version.prerelease.length > 0 ? nextPrerelease(version) : nextStable(version);
          if (next) candidates.add(next);
        }
      }
    }
  }
  return [...candidates].some((candidate) => ranges.every((range) => range.test(candidate)));
}

function nextPrerelease(version) {
  const extended = `${version.version}.0`;
  if (semver.valid(extended)) return extended;
  // At semver's MAX_LENGTH, appending .0 can be invalid. Advance an identifier
  // within the limit instead, dropping later identifiers when necessary.
  const candidates = [];
  const add = (candidate) => {
    if (!semver.valid(candidate) || !semver.gt(candidate, version)) return false;
    candidates.push(candidate);
    return true;
  };
  const alphabet = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const identifiers = version.prerelease.map(String);
  for (let index = identifiers.length - 1; index >= 0; index--) {
    const prefix = `${version.major}.${version.minor}.${version.patch}-${identifiers.slice(0, index).join('.')}${index ? '.' : ''}`;
    const identifier = identifiers[index];
    if (/^\d+$/.test(identifier)) {
      add(prefix + nextNumericIdentifier(identifier));
      add(`${prefix}-`); // every nonnumeric identifier follows every numeric one
    } else {
      add(`${prefix}${identifier}-`);
      for (let position = identifier.length - 1; position >= 0; position--) {
        for (const character of alphabet.slice(alphabet.indexOf(identifier[position]) + 1)) {
          const next = identifier.slice(0, position) + character;
          // A digit-only prefix would sort before this nonnumeric identifier.
          if (add(prefix + next + (/^\d+$/.test(next) ? '-' : ''))) break;
        }
      }
    }
  }
  return candidates.sort(semver.compare)[0];
}

function nextNumericIdentifier(identifier) {
  const value = Number(identifier);
  if (value < Number.MAX_SAFE_INTEGER) return String(value + 1);
  // semver compares numeric identifiers as Numbers, including large strings.
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  bits.setBigUint64(0, bits.getBigUint64(0) + 1n);
  return BigInt(bits.getFloat64(0)).toString();
}

function nextStable(version) {
  const parts = [version.major, version.minor, version.patch];
  for (let index = parts.length - 1; index >= 0; index--) {
    if (parts[index] < Number.MAX_SAFE_INTEGER) {
      parts[index]++;
      return parts.join('.');
    }
    parts[index] = 0;
  }
  return undefined;
}
