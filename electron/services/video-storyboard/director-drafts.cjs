const { randomUUID } = require('node:crypto');
const { generateStoryboardDraft } = require('./ai-director.cjs');
const { prepareDraft, applyDraft } = require('./ai-draft.cjs');

// Suggestions stay outside the saved film until the editor accepts one.
function createDirectorDrafts(generate = generateStoryboardDraft) {
  const candidates = new Map();
  const running = new Set();

  function find(store, workId, token) {
    const candidate = candidates.get(token);
    if (candidate?.workId === workId && candidate.workspace === store.workspace && store.owns(workId)) return candidate;
  }

  return {
    async propose(store, workId, input) {
      if (!input || typeof input.planId !== 'string' ||
          (input.shotId !== undefined && (typeof input.shotId !== 'string' || !input.shotId))) {
        throw new Error('请选择制作方案和要编辑的镜头');
      }
      const { document } = store.read(workId);
      const key = JSON.stringify([store.workspace, workId, input.planId, input.shotId]);
      if (running.has(key)) throw new Error('分镜建议正在生成');
      running.add(key);
      try {
        const result = await generate(document, {
          planId: input.planId, shotId: input.shotId, scope: input.shotId ? 'shot' : 'plan',
          instruction: input.instruction, modelRef: input.modelRef,
        }, { workspace: store.workspace, sourceFor: assetId => store.source(workId, assetId) });
        const draft = prepareDraft(document, input, { shots: result.shots });
        const id = randomUUID();
        // Bound abandoned previews if a renderer closes while a model is responding.
        if (candidates.size >= 32) candidates.delete(candidates.keys().next().value);
        candidates.set(id, { workspace: store.workspace, workId, draft });
        return { id, modelRef: result.modelRef, skillNames: result.skillNames, shots: draft.shots };
      } finally { running.delete(key); }
    },
    apply(store, workId, token) {
      const candidate = find(store, workId, token);
      if (!candidate) throw new Error('找不到这份分镜建议，请重新生成');
      const work = store.update(workId, doc => applyDraft(doc, candidate.draft));
      candidates.delete(token);
      return work;
    },
    discard(store, workId, token) {
      if (find(store, workId, token)) candidates.delete(token);
    },
  };
}

module.exports = { createDirectorDrafts };
