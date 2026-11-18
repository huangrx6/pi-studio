/** pi-ai keys its continuation cache by Durable's provider session UUID. */
async function releaseProviderSession(runtime, conversationId) {
  try {
    const state = await runtime.harness.snapshot(runtime.durable.ProviderDoc, conversationId, runtime.context);
    // Passing undefined would clear the caches of every open conversation.
    if (typeof state?.sessionId === 'string' && state.sessionId) {
      runtime.cleanupSessionResources(state.sessionId);
    }
  } catch {
    // Cache eviction is best-effort. A failed provider cleanup must not block storage teardown.
    console.warn('[pi-studio] unable to release provider session resources');
  }
}

module.exports = { releaseProviderSession };
