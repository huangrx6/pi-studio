/** Observe the resumed run without confusing compaction with generation. */
function watchCompactionRecovery(session, { onCompacted, onComplete }) {
  let sawStreaming = false;
  let idleSince = null;
  let reported = false;
  const timer = setInterval(() => {
    if (session.isCompacting) {
      reported = false;
      sawStreaming = false;
      idleSince = null;
      return;
    }
    if (!reported) { reported = true; onCompacted(); }
    if (session.isStreaming) { sawStreaming = true; idleSince = null; return; }
    idleSince ??= Date.now();
    // Give the extension time to enqueue its continuation. Once generation has
    // resumed, only settle after idle; never expire an actively running task.
    if (Date.now() - idleSince >= (sawStreaming ? 500 : 5000)) {
      clearInterval(timer);
      onComplete();
    }
  }, 250);
  return () => clearInterval(timer);
}

module.exports = { watchCompactionRecovery };
