import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ArrowUp, ImagePlus, LoaderCircle, MessageCirclePlus, Square, X } from 'lucide-react';
import { Markdown } from './Markdown';
import { ModelPicker } from './ModelPicker';
import type { ModelSelection, ThinkingLevel } from '../model-types';
import { peekTemporary, sendTemporary, subscribeTemporary, temporaryState, updateTemporary, type TemporaryImage } from '../temporary-chat-store';

export function TemporaryChat({ id, selection, onManage }: { id: string; selection: ModelSelection; onManage: () => void }) {
  const state = useSyncExternalStore(listener => subscribeTemporary(id, listener), () => temporaryState(id, selection));
  const upload = useRef<HTMLInputElement>(null), scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true), picking = useRef(false);
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
  return <section className="temporary-chat" aria-label="临时聊天" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void addImages([...event.dataTransfer.files]); } }}>
    <div className="temporary-bar">临时聊天<span>关闭标签或退出应用后清除</span></div>
    <div className="temporary-scroll" ref={scroll} onWheel={event => { if (event.deltaY < 0) following.current = false; }} onScroll={() => { const node = scroll.current; if (node) following.current = node.scrollHeight-node.scrollTop-node.clientHeight < 60; }}>
      {!state.messages.length && <div className="temporary-empty"><MessageCirclePlus /><h2>聊点什么？</h2><p>无需工作区，支持文字和图片。<br />聊天内容不会保存到本地历史记录。</p></div>}
      <div className="temporary-messages">{state.messages.map((message,index) => <article key={`${message.role}:${message.timestamp}`} className={`temporary-message is-${message.role}`}>
        {message.content.map((block,part) => block.type === 'text' ? <Markdown key={part}>{block.text}</Markdown> : block.type === 'image' ? <img key={part} src={`data:${block.mimeType};base64,${block.data}`} alt="上传的图片" /> : block.type === 'thinking' && block.thinking ? <details key={part} open={state.busy && index === state.messages.length-1}><summary>{state.busy && index === state.messages.length-1 ? '正在推理…' : '查看推理'}</summary><Markdown>{block.thinking}</Markdown></details> : null)}
        {message.errorMessage && <p className="temporary-error">{message.errorMessage}</p>}
      </article>)}
      {state.busy && <div className="temporary-running" role="status"><LoaderCircle className="spin" />正在回复…</div>}
      </div>
    </div>
    <div className="temporary-composer-dock">
      {state.error && <div className="temporary-error" role="alert">{state.error}<button className="icon-button" aria-label="关闭聊天错误" onClick={() => updateTemporary(id,{error:''})}><X /></button></div>}
      <div className="temporary-composer" onPaste={event => { const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/')); if (images.length) { event.preventDefault(); void addImages(images); } }}>
        {state.images.length > 0 && <div className="temporary-attachments">{state.images.map(image => <button key={image.id} aria-label={`移除 ${image.name}`} onClick={() => updateTemporary(id, { images: state.images.filter(item => item.id !== image.id) })}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} /><span><X /></span></button>)}</div>}
        <textarea aria-label="临时聊天消息" placeholder="随便聊聊，或添加图片…" value={state.draft} onChange={event => updateTemporary(id, { draft: event.target.value })} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); following.current = true; void sendTemporary(id); } }} />
        <div className="temporary-composer-tools">
          <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { if (event.target.files) void addImages([...event.target.files]); event.target.value = ''; }} />
          <button className="icon-button" title="添加图片" aria-label="临时聊天添加图片" onClick={() => upload.current?.click()}><ImagePlus /></button>
          <ModelPicker selection={state.selection} scope="session" disabled={state.busy} hidden={false} loadCatalog={() => window.piApi.models()} onSelectModel={modelRef => chooseModel(modelRef)} onSelectThinking={level => chooseModel(state.selection.modelRef, level)} onManage={onManage} />
          {state.busy ? <button className="temporary-send" aria-label="停止临时回复" onClick={() => void window.piApi.temporaryStop(id).catch(err => updateTemporary(id,{error:String(err)}))}><Square /></button> : <button className="temporary-send" aria-label="发送临时消息" disabled={!state.draft.trim() && !state.images.length} onClick={() => { following.current = true; void sendTemporary(id); }}><ArrowUp /></button>}
        </div>
      </div>
    </div>
  </section>;
}
