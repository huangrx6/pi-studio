'use strict';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemver(value, options = {}) {
  if (typeof value !== 'string') throw new Error('语义化版本必须是字符串');
  const input = options.allowV && value.startsWith('v') ? value.slice(1) : value;
  const match = SEMVER_PATTERN.exec(input.trim());
  if (!match) throw new Error(`无效的语义化版本：${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ? match[5].split('.') : [],
    raw: input.trim(),
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left.localeCompare(right, 'en');
}

function compareSemver(leftValue, rightValue) {
  const left = typeof leftValue === 'string' ? parseSemver(leftValue) : leftValue;
  const right = typeof rightValue === 'string' ? parseSemver(rightValue) : rightValue;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared < 0 ? -1 : 1;
  }
  return 0;
}

function parsePartial(value) {
  const match = /^(0|[1-9]\d*|[xX*])(?:\.(0|[1-9]\d*|[xX*]))?(?:\.(0|[1-9]\d*|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error(`无效的版本范围：${value}`);
  const numeric = (part) => part === undefined || part === 'x' || part === 'X' || part === '*'
    ? null
    : Number(part);
  return {
    major: numeric(match[1]),
    minor: numeric(match[2]),
    patch: numeric(match[3]),
    prerelease: match[4] || '',
    precision: match[3] !== undefined && numeric(match[3]) !== null
      ? 3
      : match[2] !== undefined && numeric(match[2]) !== null
        ? 2
        : numeric(match[1]) !== null
          ? 1
          : 0,
  };
}

function floorVersion(partial) {
  return `${partial.major ?? 0}.${partial.minor ?? 0}.${partial.patch ?? 0}${partial.prerelease ? `-${partial.prerelease}` : ''}`;
}

function upperVersion(partial) {
  if (partial.major === null) return null;
  if (partial.minor === null) return `${partial.major + 1}.0.0`;
  if (partial.patch === null) return `${partial.major}.${partial.minor + 1}.0`;
  return undefined;
}

function comparatorMatches(version, operator, partial) {
  const upper = upperVersion(partial);
  const floor = floorVersion(partial);
  if (operator === '^') {
    let ceiling;
    if (partial.major > 0) ceiling = `${partial.major + 1}.0.0`;
    else if (partial.minor > 0) ceiling = `0.${partial.minor + 1}.0`;
    else ceiling = `0.0.${partial.patch + 1}`;
    return compareSemver(version, floor) >= 0 && compareSemver(version, ceiling) < 0;
  }
  if (operator === '~') {
    const ceiling = partial.minor === null
      ? `${partial.major + 1}.0.0`
      : `${partial.major}.${partial.minor + 1}.0`;
    return compareSemver(version, floor) >= 0 && compareSemver(version, ceiling) < 0;
  }
  if (operator === '>=') return compareSemver(version, floor) >= 0;
  if (operator === '>') return compareSemver(version, floor) > 0;
  if (operator === '<=') return compareSemver(version, floor) <= 0;
  if (operator === '<') return compareSemver(version, floor) < 0;
  if (upper) return compareSemver(version, floor) >= 0 && compareSemver(version, upper) < 0;
  return compareSemver(version, floor) === 0;
}

function rangeTokens(range) {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(range.trim());
  if (hyphen) {
    const lower = parsePartial(hyphen[1]);
    const upper = parsePartial(hyphen[2]);
    const upperOperator = upper.precision < 3 ? '<' : '<=';
    return [`>=${floorVersion(lower)}`, `${upperOperator}${floorVersion(upper)}`];
  }
  return range.split(/\s+/).filter(Boolean);
}

function satisfiesSemver(versionValue, rangeValue) {
  let version;
  try {
    version = parseSemver(versionValue, { allowV: true });
  } catch {
    return false;
  }
  if (rangeValue === undefined || rangeValue === null || String(rangeValue).trim() === '') return true;
  const alternatives = String(rangeValue).split('||').map((item) => item.trim()).filter(Boolean);
  for (const alternative of alternatives) {
    const tokens = alternative === '*' ? [] : rangeTokens(alternative);
    if (tokens.length === 0) return version.prerelease.length === 0 || alternative.includes('-');
    const includesPrerelease = /-\d|[A-Za-z]-[A-Za-z]|-/.test(alternative);
    if (version.prerelease.length > 0 && !includesPrerelease) continue;
    let matches = true;
    for (const rawToken of tokens) {
      const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(rawToken);
      if (!match) {
        matches = false;
        break;
      }
      const operator = match[1] || '';
      try {
        if (!comparatorMatches(version, operator, parsePartial(match[2]))) {
          matches = false;
          break;
        }
      } catch {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function isValidSemverRange(rangeValue) {
  if (rangeValue === undefined || rangeValue === null) return true;
  const range = String(rangeValue).trim();
  if (!range || range === '*') return true;
  for (const alternative of range.split('||').map((item) => item.trim())) {
    if (!alternative) return false;
    const tokens = rangeTokens(alternative);
    if (tokens.length === 0) continue;
    for (const rawToken of tokens) {
      const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(rawToken);
      if (!match) return false;
      try {
        parsePartial(match[2]);
      } catch {
        return false;
      }
    }
  }
  return true;
}

module.exports = {
  compareSemver,
  isValidSemverRange,
  parseSemver,
  satisfiesSemver,
};
