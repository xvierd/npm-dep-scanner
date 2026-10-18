import { parentPort, workerData } from 'node:worker_threads';
import picomatch from 'picomatch';

// Picomatch's built-in range fallback is a character class. Supply a bounded
// alternation for numeric, padded and stepped ranges without a braces dependency.
function expandRange(...args) {
  args.pop(); // Picomatch appends its options object.
  const [from, to, increment = '1'] = args;
  const numeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
  const alpha = /^[a-zA-Z]$/.test(from) && /^[a-zA-Z]$/.test(to);
  const start = numeric ? Number(from) : from?.charCodeAt(0);
  const end = numeric ? Number(to) : to?.charCodeAt(0);
  const step = Math.abs(Number(increment));
  const count = Math.floor(Math.abs(end - start) / step) + 1;
  if ((!numeric && !alpha) || args.length > 3 || ![start, end, step, count].every(Number.isSafeInteger)
    || step === 0 || count > 4096) throw new Error('unsupported or oversized brace range');
  const padded = numeric && (/^-?0\d/.test(from) || /^-?0\d/.test(to));
  const width = Math.max(from.replace(/^-/, '').length, to.replace(/^-/, '').length);
  const values = [];
  for (let i = 0; i < count; i++) {
    const value = start + i * step * (end >= start ? 1 : -1);
    let text = numeric ? String(value) : String.fromCharCode(value);
    if (padded) text = (value < 0 ? '-' : '') + String(Math.abs(value)).padStart(width, '0');
    values.push(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return `(?:${values.join('|')})`;
}

// A pattern array is an ordered inclusion/exclusion list, not picomatch's OR
// across functions (which would let a negative pattern include unrelated paths).
const rules = workerData.patterns.map((pattern) => {
  const matcher = picomatch(pattern, { dot: workerData.dot, expandRange, regex: false }, true);
  return { matcher, negative: !!matcher.state.negated };
});
const onlyNegative = rules.every((rule) => rule.negative);
const matches = workerData.candidates.filter((candidate) => {
  let included = onlyNegative;
  for (const { matcher, negative } of rules) {
    if (negative ? !matcher(candidate) : matcher(candidate)) included = !negative;
  }
  return included;
});
parentPort.postMessage(matches);
