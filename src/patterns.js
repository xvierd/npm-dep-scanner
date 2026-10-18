import { Worker } from 'node:worker_threads';

const MAX_PATTERNS = 128;
const MAX_PATTERN_LENGTH = 1024;
const MAX_NESTING = 8;
const MAX_EXPANSIONS = 4096;
const MATCH_TIMEOUT_MS = 1500;

/**
 * Validate before passing user-controlled globs to a glob parser. The iterative
 * walk bounds nesting and the combined brace/alternative expansion budget,
 * including products such as {1..100}{1..100}; it never expands a pattern.
 */
export function validatePatterns(patterns, { label = 'patterns' } = {}) {
  const invalid = (reason) => {
    throw new Error(`Invalid ${label}: ${reason}`);
  };
  if (!Array.isArray(patterns) || patterns.length > MAX_PATTERNS) {
    invalid(`expected at most ${MAX_PATTERNS} patterns`);
  }

  let total = 0;
  const bounded = (count) => {
    if (!Number.isSafeInteger(count) || count > MAX_EXPANSIONS) {
      invalid(`expansion budget exceeds ${MAX_EXPANSIONS}`);
    }
    return count;
  };

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
      invalid(`each pattern must contain 1–${MAX_PATTERN_LENGTH} characters`);
    }
    if (/[\u0000-\u001f]/.test(pattern)) invalid('control characters are not supported');

    const stack = [{ opener: '', product: 1, sum: 0, start: 0 }];
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i];
      const frame = stack[stack.length - 1];
      if (char === '\\') {
        if (++i === pattern.length) invalid('trailing escape');
        continue;
      }
      if (frame.opener === '[') {
        if (char === ']') stack.pop();
        continue;
      }
      // The brace parser treats quoted delimiters as literals. Reject this
      // uncommon syntax rather than let it hide nesting from our validator.
      if ('\"\'`'.includes(char)) invalid('quoted glob syntax is not supported; escape literal quotes');
      if ('{(['.includes(char)) {
        if (stack.length > MAX_NESTING) invalid(`nesting exceeds ${MAX_NESTING}`);
        stack.push({ opener: char, product: 1, sum: 0, start: i + 1 });
      } else if ('})]'.includes(char)) {
        if (frame.opener !== ({ '}': '{', ')': '(', ']': '[' })[char]) {
          invalid('unbalanced delimiters');
        }
        stack.pop();
        let count = bounded(frame.sum + frame.product);
        if (frame.opener === '{' && frame.sum === 0 && frame.range) {
          count = bounded(rangeSize(pattern.slice(frame.start, i), invalid) ?? count);
        }
        const parent = stack[stack.length - 1];
        parent.product = bounded(parent.product * count);
      } else if ((char === ',' && frame.opener === '{') || (char === '|' && frame.opener === '(')) {
        frame.sum = bounded(frame.sum + frame.product);
        frame.product = 1;
      } else if (char === '.' && pattern[i + 1] === '.' && frame.opener === '{') {
        frame.range = true;
      }
    }
    if (stack.length !== 1) invalid('unbalanced delimiters');
    total = bounded(total + stack[0].product);
  }
  return patterns;
}

function rangeSize(content, invalid) {
  if (!content.includes('..')) return null;
  const numeric = content.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  const alpha = content.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
  if (!numeric && !alpha) {
    invalid('unsupported brace range');
  }
  const match = numeric ?? alpha;
  const start = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const end = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  const step = match[3] === undefined ? 1 : Math.abs(Number(match[3]));
  if (![start, end, step].every(Number.isSafeInteger) || step === 0) {
    invalid('brace range requires safe integers and a nonzero step');
  }
  return Math.floor(Math.abs(end - start) / step) + 1;
}

/** Return matching values in input order, with duplicates removed. */
export async function matchPatterns(values, patterns, { label = 'patterns', dot = false } = {}) {
  validatePatterns(patterns, { label });
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new TypeError('Pattern candidates must be an array of strings');
  }
  if (values.length === 0 || patterns.length === 0) return [];
  return matchInWorker([...new Set(values)], patterns, { label, dot });
}

// Even short valid globs can produce catastrophic regex backtracking. Keep the
// parser AND matching off the main thread so the deadline can interrupt either.
function matchInWorker(candidates, patterns, { label, dot }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workspace-matcher.js', import.meta.url), {
      workerData: { candidates, patterns, dot },
      // Inherited flags such as --input-type=module are invalid for a file worker.
      execArgv: [],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(`Invalid ${label}: matching exceeded ${MATCH_TIMEOUT_MS} ms`);
      // Wait for termination before rejecting, so no busy matcher is left behind.
      worker.terminate().then(() => reject(error), () => reject(error));
    }, MATCH_TIMEOUT_MS);
    const finish = (error, matches) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(`Invalid ${label}: ${error.message}`, { cause: error }));
      else resolve(matches);
    };
    worker.once('message', (matches) => finish(null, matches));
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(`matcher exited without results (code ${code})`));
    });
  });
}
