'use strict';

const { createHash } = require('node:crypto');

const MAX_FINDINGS = 12;
const PLACEHOLDER = /^(?:<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|example|sample|redacted|changeme|your[-_].*|token)$/i;

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

function acceptable(value) {
  const text = String(value || '').trim();
  return text.length >= 8 && !PLACEHOLDER.test(text);
}

/**
 * Find a deliberately small set of high-confidence credentials in outbound
 * user text. This is a warning boundary, never a proof that text is safe.
 */
function scanSensitiveInput(textValue) {
  const text = typeof textValue === 'string' ? textValue : '';
  if (!text) return [];
  const searchableText = text
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/\$\{[^}]+\}/g, '');
  const findings = [];
  const seen = new Set();
  const add = (kind, value) => {
    if (!acceptable(value)) return;
    const digest = fingerprint(value);
    if (seen.has(digest) || findings.length >= MAX_FINDINGS) return;
    seen.add(digest);
    findings.push({ kind, fingerprint: digest });
  };

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(searchableText)) {
    add('private-key', `private-key:${fingerprint(text)}`);
  }
  for (const match of searchableText.matchAll(/\bAuthorization\s*:\s*Bearer\s+([^\s,;'"]+)/gi)) {
    add('authorization', match[1]);
  }
  for (const match of searchableText.matchAll(/\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|passwd|secret)\b\s*[:=]\s*["']?([^\s,"'`}]+)/gi)) {
    add('named-secret', match[1]);
  }
  for (const match of searchableText.matchAll(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g)) {
    add('provider-token', match[0]);
  }
  for (const match of searchableText.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi)) {
    add('url-password', match[1]);
  }
  return findings;
}

function sensitiveLabels(findings) {
  const labels = {
    authorization: 'Authorization Bearer 凭据',
    'named-secret': '命名的密钥或密码',
    'provider-token': '模型或代码平台访问令牌',
    'private-key': '私钥内容',
    'url-password': 'URL 中的密码',
  };
  return [...new Set(findings.map(finding => labels[finding.kind] || '敏感凭据'))];
}

module.exports = { fingerprint, scanSensitiveInput, sensitiveLabels };
