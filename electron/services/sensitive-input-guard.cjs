'use strict';

const { getStudioDatabase } = require('../core/studio-db.cjs');
const { scanSensitiveInput, sensitiveLabels } = require('../core/sensitive-input.cjs');
const { requestPolicyConfirmation } = require('./confirmations.cjs');

const SETTING_KEY = 'studio.sensitive-input-exemptions';
const MAX_SESSION_EXEMPTIONS = 64;

function readExemptions() {
  const stored = getStudioDatabase().getSetting(SETTING_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function sessionExemptions(sessionId) {
  const values = readExemptions()[sessionId];
  return Array.isArray(values)
    ? values.filter(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    : [];
}

function rememberSessionExemptions(sessionId, fingerprints) {
  const store = readExemptions();
  const next = [...new Set([...sessionExemptions(sessionId), ...fingerprints])].slice(-MAX_SESSION_EXEMPTIONS);
  const sessions = Object.entries(store)
    .filter(([id, values]) => id !== sessionId && Array.isArray(values) && values.length > 0)
    .slice(-63);
  getStudioDatabase().setSetting(SETTING_KEY, { ...Object.fromEntries(sessions), [sessionId]: next });
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
