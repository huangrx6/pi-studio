'use strict';

const { getStudioDatabase } = require('../core/studio-db.cjs');
const { scanSensitiveInput, sensitiveLabels } = require('../core/sensitive-input.cjs');
const { requestPolicyConfirmation } = require('./confirmations.cjs');

const SETTING_KEY = 'studio.sensitive-input-exemptions';
const MAX_SESSION_IDS = 64;
const MAX_FINGERPRINTS_PER_SESSION = 64;
const RESERVED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA_256 = /^[a-f0-9]{64}$/;

function normalizeSessionId(value) {
  if (typeof value !== 'string') return '';
  const sessionId = value.trim();
  return SAFE_SESSION_ID.test(sessionId) && !RESERVED_OBJECT_KEYS.has(sessionId)
    ? sessionId
    : '';
}

function normalizeFingerprints(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const raw of value) {
    const fingerprint = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!SHA_256.test(fingerprint)) continue;
    if (seen.has(fingerprint)) seen.delete(fingerprint);
    seen.add(fingerprint);
    if (seen.size > MAX_FINGERPRINTS_PER_SESSION) {
      seen.delete(seen.values().next().value);
    }
  }
  return [...seen];
}

function normalizeExemptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).flatMap(([rawSessionId, rawFingerprints]) => {
    const sessionId = normalizeSessionId(rawSessionId);
    if (!sessionId) return [];
    const fingerprints = normalizeFingerprints(rawFingerprints);
    return fingerprints.length > 0 ? [[sessionId, fingerprints]] : [];
  });
  return Object.fromEntries(entries.slice(-MAX_SESSION_IDS));
}

function readExemptions() {
  return getStudioDatabase().getSettingWithRecovery(
    SETTING_KEY,
    {},
    normalizeExemptions,
  );
}

function sessionExemptions(sessionId) {
  const id = normalizeSessionId(sessionId);
  return id ? [...(readExemptions()[id] || [])] : [];
}

function rememberSessionExemptions(sessionId, fingerprints) {
  const id = normalizeSessionId(sessionId);
  if (!id) throw new Error('敏感输入豁免需要有效会话 ID');
  const store = readExemptions();
  const current = store[id] || [];
  const additions = normalizeFingerprints(fingerprints);
  if (additions.length === 0) return [...current];
  const next = normalizeFingerprints([...current, ...additions]);
  const sessions = Object.entries(store)
    .filter(([existingId, values]) => existingId !== id && values.length > 0)
    .slice(-63);
  getStudioDatabase().setSetting(SETTING_KEY, {
    ...Object.fromEntries(sessions),
    [id]: next,
  });
  return next;
}

async function guardSensitiveInput({ sessionId, text }) {
  if (!sessionId) throw new Error('发送敏感信息前需要有效会话');
  const exempt = new Set(sessionExemptions(sessionId));
  const findings = scanSensitiveInput(text).filter(finding => !exempt.has(finding.fingerprint));
  if (findings.length === 0) return { accepted: true, findings: [], remembered: false };
  const labels = sensitiveLabels(findings).join('、');
  const preview = findings.slice(0, 3).map(item => item.fingerprint.slice(0, 10)).join('、');
  const result = await requestPolicyConfirmation({
    sessionId,
    tool: 'sensitive-input',
    title: '这段消息包含可能的凭据',
    message: `仅发送文本 · ${labels} · 指纹 ${preview}`,
    explanation: '凭据会进入当前模型请求和会话记录。选择“本会话”只会豁免这些完全相同的值；内容变化后仍会再次提醒。',
    risk: {
      level: 'high',
      title: '凭据可能被模型或会话记录接收',
      detail: '确认这是一段用于测试且允许发送的凭据。',
    },
    rememberScopes: ['session'],
  });
  if (!result.accepted) throw new Error('已取消发送包含敏感信息的消息');
  if (result.remember === 'session') {
    rememberSessionExemptions(sessionId, findings.map(item => item.fingerprint));
  }
  return {
    accepted: true,
    findings,
    remembered: result.remember === 'session',
  };
}

module.exports = {
  guardSensitiveInput,
  rememberSessionExemptions,
  sessionExemptions,
};
