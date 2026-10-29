import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, ImagePlus, LoaderCircle, MessageCirclePlus, Square, X } from 'lucide-react';
import { AssistantTurnView, ChatMessageView } from './ChatMessage';
import { ModelPicker } from './ModelPicker';
import type { ModelSelection, ThinkingLevel } from '../types/model-types';
import { peekTemporary, sendTemporary, subscribeTemporary, temporaryState, updateTemporary, type TemporaryImage } from '../lib/temporary-chat-store';

export function TemporaryChat({ id, selection, onManage }: { id: string; selection: ModelSelection; onManage: () => void }) {
  const state = useSyncExternalStore(listener => subscribeTemporary(id, listener), () => temporaryState(id, selection));
  const upload = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true), picking = useRef(false);
  const [stopping, setStopping] = useState(false);
  const toolResults = useMemo(() => new Map(), []);
  useEffect(() => { if (!state.selection.modelRef) void window.piApi.temporaryModel().then(next => updateTemporary(id, { selection: next })).catch(err => updateTemporary(id, { error: String(err) })); }, [id, state.selection.modelRef]);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state.messages, state.busy]);
  async function addImages(files: File[]) {
    if (picking.current) return;
    picking.current = true;
    try {
      const current = temporaryState(id, selection);
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
    } catch (err) { updateTemporary(id, { error: String(err instanceof Error ? err.message : err) }); }
    finally { picking.current = false; }
  }
  async function chooseModel(modelRef: string, thinkingLevel?: ThinkingLevel) {
    const next = await window.piApi.temporaryModel({ modelRef, thinkingLevel }); updateTemporary(id, { selection: next });
  }
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await window.piApi.temporaryStop(id);
      updateTemporary(id, { busy: false, error: '' });
    } catch (error) {
      updateTemporary(id, { error: String(error) });
    } finally {
      setStopping(false);
    }
  }
  const lastMessage = state.messages.at(-1);
  return <section className="temporary-chat" aria-label="临时聊天" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addImages([...event.dataTransfer.files]); } }}>
    <div className="temporary-scroll" ref={scroll} onWheel={event => { if (event.deltaY < 0) following.current = false; }} onScroll={() => { const node = scroll.current; if (node) following.current = node.scrollHeight-node.scrollTop-node.clientHeight < 60; }}>
      <div className="chat-column">
        {!state.messages.length && <div className="temporary-empty">
          <span className="temporary-empty-mark"><MessageCirclePlus /></span>
          <h2>聊点什么？</h2>
          <p>无需工作区，支持文字和图片。关闭标签或退出应用后，这段对话会自动清除。</p>
        </div>}
        {state.messages.length > 0 && <div className="messages temporary-messages">
          {state.messages.map((message, index) => message.role === 'user'
            ? <ChatMessageView key={`user:${message.timestamp}:${index}`} message={message} />
            : message.role === 'assistant'
              ? <AssistantTurnView
                key={`assistant:${message.timestamp}:${index}`}
                messages={[message]}
                toolResults={toolResults}
                busy={state.busy && index === state.messages.length - 1}
                stepDisplay="standard"
                stepCollapse="keep-open"
              />
              : null)}
          {state.busy && lastMessage?.role !== 'assistant' && <div className="thinking temporary-thinking" role="status"><span /><span /><span />正在思考</div>}
        </div>}
      </div>
    </div>
    <div className="temporary-composer-dock">
      {state.error && <div className="error-card temporary-error-card" role="alert">
        <span>{state.error}</span>
        <button type="button" className="icon-button" aria-label="关闭聊天错误" onClick={() => updateTemporary(id,{error:''})}><X /></button>
      </div>}
      <div className="composer temporary-composer" onPaste={event => { const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void addImages(images); } }}>
        {state.images.length > 0 && <div className="temporary-attachments">{state.images.map(image => <button key={image.id} aria-label={`移除 ${image.name}`} onClick={() => updateTemporary(id, { images: state.images.filter(item => item.id !== image.id) })}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><span><X /></span></button>)}</div>}
        <textarea className="temporary-textarea" aria-label="临时聊天消息" placeholder="随便聊聊，或添加图片…" value={state.draft} onChange={event => updateTemporary(id, { draft: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); following.current = true; void sendTemporary(id); } }} />
        <div className="composer-bar">
          <div className="composer-left">
            <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { if (event.target.files) void addImages([...event.target.files]); event.target.value = ''; }} />
            <button type="button" className="composer-attach-button" title="添加图片" aria-label="临时聊天添加图片" onClick={() => upload.current?.click()}><ImagePlus /></button>
          </div>
          <div className="composer-right">
            <ModelPicker selection={state.selection} scope="session" disabled={state.busy} hidden={false} loadCatalog={() => window.piApi.models()} onSelectModel={modelRef => chooseModel(modelRef)} onSelectThinking={level => chooseModel(state.selection.modelRef, level)} onManage={onManage} />
            {state.busy
              ? <button type="button" className="send-button is-stop" disabled={stopping} aria-label={stopping ? '正在停止临时回复' : '停止临时回复'} title={stopping ? '正在停止临时回复' : '停止临时回复'} onClick={() => void stop()}>{stopping ? <LoaderCircle className="spin" aria-hidden="true" /> : <Square fill="currentColor" aria-hidden="true" />}</button>
              : <button type="button" className="send-button" aria-label="发送临时消息" disabled={!state.draft.trim() && !state.images.length} onClick={() => { following.current = true; void sendTemporary(id); }}><ArrowUp /></button>}
          </div>
        </div>
      </div>
    </div>
  </section>;
}
