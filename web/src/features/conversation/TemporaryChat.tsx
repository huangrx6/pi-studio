import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, ImagePlus, Square } from 'lucide-react';
import { JumpToLatestButton } from '../../shared/JumpToLatestButton';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import { ChatMessageView } from './ChatMessage';
import { AssistantTurnView } from './AssistantTurn';
import { NarrativeLiveStatus } from './NarrativeWorkstream';
import { groupTranscript } from './turn-content';
import { ComposerImageAttachment } from './ComposerImageAttachment';
import { ComposerFeedback } from './ComposerFeedback';
import { ModelPicker } from '../models/ModelPicker';
import { ProviderQuotaStatus } from '../models/ProviderQuotaView';
import { modelQuotaSource } from '../../types/provider-quota';
import type { ExtensionUiItem } from '../../types/extension-types';
import type { SettingsSnapshot } from '../../types/global.d';
import { createEmptyModelSelection, type ThinkingLevel } from '../../types/model-types';
import { loadTemporaryRecord, peekTemporary, sendTemporary, subscribeTemporary, temporaryState, updateTemporary, type TemporaryImage } from './temporary-chat-store';
import { temporaryChatCanSubmit, temporaryChatEnterAction } from './temporary-chat-input';
import { isNearBottom, nestedScrollableConsumesWheel } from './chat-scroll.ts';
import { errorText } from '../../shared/error-text';
import './styles/welcome-art.css';
import './styles/temporary-chat-canvas.css';

const initialSelection = createEmptyModelSelection();

export function TemporaryChat({ id, onManage, savedScroll, layoutReady, onScrollPosition, quotaItem, quotaProviders }: {
  id: string;
  savedScroll?: number; layoutReady?: boolean; onScrollPosition?: (top:number)=>void;
  onManage: () => void;
  quotaItem?: ExtensionUiItem;
  quotaProviders?: SettingsSnapshot['providers'];
}) {
  const state = useSyncExternalStore(listener => subscribeTemporary(id, listener), () => temporaryState(id, initialSelection));
  const upload = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true), picking = useRef(false);
  const autoScrollFrame = useRef<number | null>(null);
  const programmedScrollTop = useRef<number | null>(null);
  const lastScrollTop = useRef(0);
  const pendingPosition = useRef<{ report: (top: number) => void; top: number }>();
  const positionTimer = useRef<ReturnType<typeof setTimeout>>();
  function flushPosition() {
    clearTimeout(positionTimer.current);
    const pending = pendingPosition.current;
    pendingPosition.current = undefined;
    if (pending) pending.report(pending.top);
  }
  useLayoutEffect(() => {
    window.addEventListener('pagehide', flushPosition);
    return () => {
      window.removeEventListener('pagehide', flushPosition);
      flushPosition();
    };
  }, [id]);
  const initializingModel = useRef(false), modelRequest = useRef(0);
  const modelOwnerActive = useRef(false);
  useEffect(() => {
    modelOwnerActive.current = true;
    return () => { modelOwnerActive.current = false; };
  }, []);
  function ownsModelRequest(request: number) {
    return modelOwnerActive.current && request === modelRequest.current;
  }
  const [atBottom, setAtBottom] = useState(true);
  const [stopping, setStopping] = useState(false);
  const { turns, results: toolResults } = useMemo(() => groupTranscript(state.messages), [state.messages]);
  const tailTurn = turns.at(-1);
  const images = useMemo(
    () => state.images.map((image) => ({
      src: `data:${image.mimeType};base64,${image.data}`,
      alt: image.name,
    })),
    [state.images],
  );
  useEffect(() => {
    if (state.historyStatus === 'loading') void loadTemporaryRecord(id);
  }, [id, state.historyStatus]);
  useEffect(() => {
    if (state.historyStatus !== 'ready' || state.selection.modelRef || initializingModel.current) return;
    initializingModel.current = true;
    const request = ++modelRequest.current;
    void window.piApi.temporaryModel()
      .then(next => { if (ownsModelRequest(request)) updateTemporary(id, { selection: next, modelSettled: true }); })
      .catch(error => { if (ownsModelRequest(request)) updateTemporary(id, { modelSettled: true, error: errorText(error) }); })
      .finally(() => { initializingModel.current = false; });
  }, [id, state.historyStatus, state.selection.modelRef]);
  useEffect(() => {
    if (!state.autoSubmit || !state.draft.trim() || state.busy || !state.selection.modelRef || state.selection.unavailable) return;
    updateTemporary(id, { autoSubmit: false });
    void sendTemporary(id);
  }, [id, state.autoSubmit, state.busy, state.draft, state.selection.modelRef, state.selection.unavailable]);
  function cancelAutoScroll() {
    if (autoScrollFrame.current === null) return;
    cancelAnimationFrame(autoScrollFrame.current);
    autoScrollFrame.current = null;
  }
  function pinToBottom() {
    const node = scroll.current;
    if (!node || !following.current) return;
    const target = Math.max(0, node.scrollHeight - node.clientHeight);
    if (Math.abs(node.scrollTop - target) > 0.5) {
      programmedScrollTop.current = target;
      node.scrollTop = target;
    }
    lastScrollTop.current = target;
    setAtBottom(true);
  }
  function resumeFollow() {
    following.current = true;
    pinToBottom();
  }
  function pauseFollow() {
    following.current = false;
    programmedScrollTop.current = null;
    cancelAutoScroll();
  }
  function onTranscriptScroll(node: HTMLDivElement) {
    const top = node.scrollTop;
    const pinned = programmedScrollTop.current !== null && Math.abs(top - programmedScrollTop.current) <= 1;
    const nearBottom = isNearBottom(node);
    if (!pinned && top < lastScrollTop.current - 0.5) pauseFollow();
    else if (pinned || (nearBottom && top > lastScrollTop.current)) following.current = true;
    programmedScrollTop.current = null;
    lastScrollTop.current = top;
    setAtBottom(nearBottom);
    if (layoutReady && state.historyStatus === 'ready' && node.clientHeight > 0 && !pinned && onScrollPosition) {
      pendingPosition.current = { report: onScrollPosition, top: nearBottom ? -1 : top };
      clearTimeout(positionTimer.current);
      positionTimer.current = setTimeout(flushPosition, 160);
    }
  }
  function scheduleAutoScroll() {
    if (!following.current || autoScrollFrame.current !== null) return;
    autoScrollFrame.current = requestAnimationFrame(() => {
      autoScrollFrame.current = null;
      pinToBottom();
    });
  }
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    following.current = savedScroll === undefined || savedScroll < 0;
    programmedScrollTop.current = null;
    if (following.current) pinToBottom();
    else if (layoutReady && state.historyStatus === 'ready') { node.scrollTop = savedScroll!; lastScrollTop.current = node.scrollTop; }

    // Observe real size changes, including streaming text, images and panel resizes.
    const observer = new ResizeObserver(() => {
      if (following.current) scheduleAutoScroll();
      else if (isNearBottom(node, 1)) resumeFollow();
      else setAtBottom(isNearBottom(node));
    });
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => { observer.disconnect(); cancelAutoScroll(); };
  }, [id, state.historyStatus, layoutReady]);
  async function addImages(files: File[]) {
    if (picking.current || state.historyStatus !== 'ready' || state.busy) return;
    picking.current = true;
    try {
      if (!state.selection.modelRef || state.selection.unavailable) {
        throw new Error('请先选择可用模型，再添加图片。');
      }
      if (files.length > 0 && state.selection.supportsImages === false) {
        throw new Error(`${state.selection.label || '当前模型'} 不支持图片输入。请切换到支持图片的模型后再添加图片。`);
      }
      const current = temporaryState(id, initialSelection);
      if (current.images.length + files.length > 8) throw new Error('最多添加 8 张图片');
      const images: TemporaryImage[] = [];
      for (const file of files) {
        if (!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)) throw new Error('请添加 PNG、JPEG、WebP 或 GIF 图片');
        if (file.size > 10*1024*1024) throw new Error('单张图片不能超过 10 MB');
        const data = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        images.push({ id: crypto.randomUUID(), name: file.name, mimeType: file.type, data });
      }
      const latest = peekTemporary(id); if (!latest) return;
      updateTemporary(id, { images: [...latest.images,...images], error: '' });
    } catch (err) { updateTemporary(id, { error: errorText(err) }); }
    finally { picking.current = false; }
  }
  async function chooseModel(modelRef: string, thinkingLevel?: ThinkingLevel) {
    const request = ++modelRequest.current;
    const next = await window.piApi.temporaryModel({ modelRef, thinkingLevel }).catch(error => {
      if (ownsModelRequest(request)) updateTemporary(id, { modelSettled: true });
      throw error;
    });
    if (!ownsModelRequest(request)) return;
    if (peekTemporary(id)?.images.length && next.supportsImages === false) {
      updateTemporary(id, { error: `${next.label || next.modelRef} 不支持图片输入。请先移除图片，再切换模型。` });
      return;
    }
    updateTemporary(id, { selection: next, modelSettled: true, error: '' });
  }
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await window.piApi.temporaryStop(id);
      updateTemporary(id, { error: '' });
    } catch (error) {
      updateTemporary(id, { error: errorText(error) });
    } finally {
      setStopping(false);
    }
  }
  const hasUsableModel = Boolean(state.selection.modelRef) && !state.selection.unavailable;
  const quotaSource = quotaItem && modelQuotaSource(state.selection, quotaProviders);
  const submissionState = {
    draft: state.draft,
    imageCount: state.images.length,
    modelRef: state.selection.modelRef,
    unavailable: state.selection.unavailable,
    busy: state.busy,
  };
  const canSubmit = temporaryChatCanSubmit(submissionState);
  if (state.historyStatus === 'loading') return <LoadingState variant="panel">正在读取临时对话…</LoadingState>;
  if (state.historyStatus === 'failed') return <section className="temporary-empty" aria-label="读取临时对话">
    <p role="alert">{state.error}</p>
    <button type="button" className="secondary-button" onClick={() => updateTemporary(id, { historyStatus: 'loading', error: '' })}>重试</button>
  </section>;
  return <section className={`temporary-chat${state.messages.length ? '' : ' is-empty'}`} aria-label="临时聊天" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addImages([...event.dataTransfer.files]); } }}>
    <div className="transcript-viewport">
      <div className="temporary-scroll" ref={scroll}
        onWheel={event => {
          if (event.deltaY < 0 && !nestedScrollableConsumesWheel(event.target, event.currentTarget, event.deltaY)) pauseFollow();
        }}
        onTouchMove={pauseFollow}
        onScroll={event => onTranscriptScroll(event.currentTarget)}>
        <div className="chat-column">
          {!state.messages.length && <div className="temporary-welcome">
            <span className="welcome-art" aria-hidden="true"><span className="pi-mark" /></span>
            <h2>和路过的念头聊一会儿。</h2>
          </div>}
          {state.messages.length > 0 && <div className="messages temporary-messages">
            {turns.map((turn, index) => {
              if (turn.kind === 'user') {
                return <ChatMessageView key={`user:${turn.message.timestamp}:${index}`} message={turn.message} />;
              }
              const previousTurn = turns[index - 1];
              return <AssistantTurnView
                key={`assistant:${index}`}
                messages={turn.messages}
                toolResults={toolResults}
                startedAt={previousTurn?.kind === 'user' ? previousTurn.message.timestamp : undefined}
                busy={state.busy && turn === tailTurn}
                stepDisplay="standard"
                stepCollapse="keep-open"
              />;
            })}
            {state.busy && tailTurn?.kind === 'user' && <NarrativeLiveStatus startedAt={tailTurn.message.timestamp} />}
          </div>}
        </div>
      </div>
      {!atBottom && <JumpToLatestButton onClick={resumeFollow} />}
    </div>
    <div className="temporary-composer-dock" onPaste={event => {
      const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
      if (!images.length) return;
      event.preventDefault();
      const text = event.clipboardData.getData('text');
      const target = event.target;
      if (text && target instanceof HTMLTextAreaElement) {
        const start = target.selectionStart;
        const end = target.selectionEnd;
        target.setRangeText(text, start, end, 'end');
        updateTemporary(id, { draft: target.value });
        requestAnimationFrame(() => {
          target.focus();
          target.setSelectionRange(start + text.length, start + text.length);
        });
      }
      // Image clipboard data can also carry useful text. Keep both instead of
      // replacing copied prose with the image attachment.
      void addImages(images);
    }}>
      {state.error && <ComposerFeedback message={state.error} onDismiss={() => updateTemporary(id, { error: '' })} />}
      {state.images.length > 0 && <div className="attachment-strip composer-attachments temporary-attachments" role="group" aria-label="待发送图片">{state.images.map((image, index) => <ComposerImageAttachment
        key={image.id}
        images={images}
        index={index}
        onRemove={() => updateTemporary(id, { images: state.images.filter(item => item.id !== image.id) })}
      />)}</div>}
      <div className="composer temporary-composer">
        <textarea rows={1} className="temporary-textarea" aria-label="临时聊天消息" placeholder="输入消息…" value={state.draft} onChange={event => updateTemporary(id, { draft: event.target.value })} onKeyDown={event => {
          const action = temporaryChatEnterAction({
            ...submissionState,
            draft: event.currentTarget.value,
            key: event.key,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.nativeEvent.keyCode,
          });
          if (action === 'send') {
            event.preventDefault();
            resumeFollow();
            void sendTemporary(id);
          }
        }} />
        <div className="composer-bar">
          <div className="composer-left">
            <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { if (event.target.files) void addImages([...event.target.files]); event.target.value = ''; }} />
            <button type="button" className="composer-attach-button" disabled={state.busy || !hasUsableModel} title={!hasUsableModel ? '选择可用模型后再添加图片' : state.selection.supportsImages === false ? '当前模型不支持图片' : '添加图片'} aria-label="临时聊天添加图片" onClick={() => upload.current?.click()}><ImagePlus /></button>
          </div>
          <div className="composer-right">
            <ModelPicker selection={state.selection} scope="session" contextKey={`temporary:${id}`} disabled={state.busy} hidden={false} loadCatalog={() => window.piApi.models()} onSelectModel={modelRef => chooseModel(modelRef)} onSelectThinking={level => chooseModel(state.selection.modelRef, level)} onManage={onManage} />
            {state.busy
              ? <button type="button" className="send-button is-stop" disabled={stopping} aria-label={stopping ? '正在停止临时回复' : '停止临时回复'} title={stopping ? '正在停止临时回复' : '停止临时回复'} onClick={() => void stop()}>{stopping ? <LoadingIndicator /> : <Square fill="currentColor" aria-hidden="true" />}</button>
              : <button type="button" className="send-button" aria-label="发送临时消息" title={!hasUsableModel ? '选择可用模型后才能发送' : undefined} disabled={!canSubmit} onClick={() => { resumeFollow(); void sendTemporary(id); }}><ArrowUp /></button>}
          </div>
        </div>
      </div>
    </div>
    {quotaItem && quotaSource && <ProviderQuotaStatus key={quotaSource.id} {...quotaSource} item={quotaItem} />}
  </section>;
}
