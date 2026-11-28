const sendRequest = /(?:[发發](?:[给給]|消息|[一条條]+(?:消息|信息))|群[发發]|[发發]送(?:消息|信息|给|給|邮件|郵件)|\b(?:send|forward)\s+(?:(?:a|the|this)\s+)?(?:message|note|reply|email)\b|\bmessage\s+[“‘"'\x60])/i;
const currentChat = /^(?:当前|當前|这个|這個)(?:群聊?|聊天|会话|會話|对话|對話)$|^(?:the current|this) (?:chat|group|conversation)$/i;

const delimiters = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"], ['`', '`'], ['**', '**'], ['__', '__']];

function readDelimitedName(text) {
  const pair = delimiters.find(([open]) => text.startsWith(open));
  if (!pair) return '';
  const end = text.indexOf(pair[1], pair[0].length);
  if (end < 0) return '';
  return text.slice(pair[0].length, end).trim();
}

function explicitRecipient(text, appName) {
  const app = typeof appName === 'string' ? appName.trim() : '';
  if (app) {
    const literal = app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp('([给給向])\\s*' + literal + '(?:中|里|裡)?的\\s*', 'gi'), '$1')
      .replace(new RegExp('\\s+on\\s+' + literal + '(?=\\s*$|[.,!?])', 'gi'), '');
  }
  // A labelled address or an object at a send verb has a name boundary independent
  // of the model's proposed name. Do not treat quoted message content as an address.
  const field = /^\s*(?:\*\*)?(?:收件人|群名|recipient)(?:\*\*)?\s*[:：]\s*([^\n，,；;]+)/im.exec(text);
  const chinese = /[给給向]\s*([^，,。！？!?；;：:]{1,120}?)\s*(?:发(?:送|一条|条|消息)|發(?:送|一條|條|消息))/i.exec(text);
  const englishAddress = /\b(?:send|forward)\s+(?:(?:(?:a |the |this )?(?:message|note|reply)|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|'[^'\n]*')\s+)?to\s+(?:the (?:group|contact)\s+)?|\bmessage\s+(?=[“‘"'`])/i.exec(text);
  const englishTail = englishAddress && text.slice(englishAddress.index + englishAddress[0].length).trimStart();
  const englishName = englishTail && (readDelimitedName(englishTail) ? englishTail
    : /^([^:：;；,.!?\n]{1,120}?)(?=\s+(?:saying)\b|[:：,.!?]|\s*$)/i.exec(englishTail)?.[1]);
  const quotedAddress = /(?:[给給向]|[发發]送[到至])\s*(?:群聊|群组|群組|联系人|聯絡人|好友)?\s*([「『“‘"'`][^\n]+)/i.exec(text);
  const matches = [field, quotedAddress, chinese].filter(Boolean)
    .map(match => ({ index: match.index, name: match[1] }));
  if (englishName) matches.push({ index: englishAddress.index, name: englishName });
  matches.sort((left, right) => left.index - right.index);
  if (!matches.length) return '';
  const raw = matches[0].name.trim();
  const value = raw.replace(/^(?:群聊|群组|群組|联系人|聯絡人|好友)(?=\s|[「『“‘"'`])\s*/, '');
  const quoted = readDelimitedName(value);
  if (quoted) return readDelimitedName(quoted) || quoted;
  if (currentChat.test(value)) return value;
  // Unquoted descriptions, lists and conditions can refer to somebody by context.
  if (/[的和与與、\n]|刚才|剛才|之前|那个|那個|\b(?:and|or|on|via|after|before|using|when|who|with)\b/i.test(value)) return '';
  return value.replace(/(群)(?:中|里|裡)$/, '$1').trim();
}

function isEnter(key) {
  const tokens = String(key ?? '').split(/[+＋]/).map(token => token.trim()).filter(Boolean);
  return /^(?:enter|return)$/i.test(tokens.at(-1));
}

function isPaste(step) {
  const keys = String(step.key || step.keys || '').toLowerCase().split(/[+＋]/).map(key => key.trim()).filter(Boolean);
  const key = keys.pop();
  const mods = [...keys, ...(step.modifiers || step.mods || [])].map(mod => String(mod).trim().toLowerCase());
  return (key === 'v' && mods.some(mod => ['cmd', 'command', 'control', 'ctrl', 'meta', 'win'].includes(mod)))
    || (key === 'insert' && mods.includes('shift'));
}

function isComposerEdit(step) {
  const key = String(step.key || step.keys || '').toLowerCase().split(/[+＋]/).map(part => part.trim()).filter(Boolean).at(-1);
  return isPaste(step) || ['backspace', 'delete', 'forwarddelete', 'del'].includes(key)
    || (key === 'x' && (/[+＋]/.test(step.key) || step.modifiers?.length || step.mods?.length));
}

function confirmedDraftEdit(tool, details) {
  const step = tool === 'desktop_act' ? details?.steps?.findLast(item => item.type !== 'wait') : details;
  if (!step?.ok) return false;
  if (tool === 'desktop_type' || step.type === 'type') return step.chars > 0 && !step.submitted;
  return isPaste({ key: step.chord || step.key });
}

async function checkChatTarget(name, args, api, durable, context, prior = {}) {
  const target = args.chatTarget;
  const actions = name === 'desktop_act' ? (args.actions || []) : [{ ...args, type: name.slice('desktop_'.length) }];
  const kind = step => String(step.type || step.action || '').trim().toLowerCase();
  if (actions.some(step => kind(step) === 'hotkey' && step.keyCode != null)) {
    throw Object.assign(new Error('请通过 key 指定命名按键或组合键。'), { code: 'desktop_hotkey_blocked' });
  }
  const typing = actions.findIndex(step => kind(step) === 'type');
  const multiline = actions.findIndex(step => kind(step) === 'type' && /[\r\n\u2028\u2029]/u.test(step.text));
  const enter = actions.some(step => (kind(step) === 'type' && step.submit === true)
    || (kind(step) === 'hotkey' && isEnter(step.key || step.keys)));
  const clipboardEdit = actions.some(step => kind(step) === 'hotkey' && isComposerEdit(step));
  if (!target && typing < 0 && !enter && !clipboardEdit) return;
  const userText = await api.commit(async tx => {
    const live = await tx.doc(durable.LiveDoc, api.conversationId);
    const id = live.run?.inputs.at(-1);
    if (id == null) return '';
    const submission = await tx.submission(id);
    const entry = submission?.entry != null && await tx.entry(submission.entry);
    return (entry?.model || []).filter(message => message.role === 'user').flatMap(message =>
      typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text)
    ).join('\n');
  }, context) || '';
  const explicit = explicitRecipient(userText, args.appName);
  if (!target) {
    if (!explicit && !sendRequest.test(userText)) return;
    if (!enter && multiline < 0 && args.searchField && actions.slice(typing + 1).every(step => kind(step) === 'wait')) return;
    throw Object.assign(new Error('请点击可辨认的搜索结果。消息提交须提供 chatTarget 和已打开会话的完整标题。'), { code: 'desktop_chat_target_required' });
  }
  const expected = String(target.requested || '').trim();
  const title = String(target.visibleTitle || '').trim();
  const stripMembers = name => name.replace(/\s*(?:\(\d+\)|（\d+）)$/, '');
  // Only a displayed group member count may differ from the requested name.
  const namedMatch = title === expected || stripMembers(title) === expected;
  const userMatch = explicit ? explicit === expected : userText.includes(expected);
  if (!expected || !title || !userMatch || (!namedMatch && !currentChat.test(expected))) {
    throw Object.assign(new Error('当前会话标题与用户指定的收件人无法核对，已停止。请让用户确认完整联系人或群名。'), { code: 'desktop_chat_target_mismatch' });
  }
  if (target.composer === 'existing' || target.composer === 'unreadable') {
    const reason = target.composer === 'existing' ? '输入框中已有草稿或待发附件' : '无法看清完整输入框及附件区';
    throw Object.assign(new Error(reason + '，已保留草稿并停止。'), { code: 'desktop_chat_draft_preserved' });
  }
  if (args.windowId == null || prior.observedWindow !== args.windowId || !['empty', 'prepared'].includes(target.composer)) {
    throw Object.assign(new Error('请先观察目标窗口的完整输入框、图片缩略图和附件区，再报告 chatTarget.composer。'), { code: 'desktop_chat_observation_required' });
  }
  // Only our successfully dispatched edit in this turn/window can explain a nonempty draft.
  const chat = JSON.stringify([args.windowId, expected, title]);
  if (target.composer === 'prepared' && prior.preparedChat !== chat) {
    throw Object.assign(new Error('无法确定已有内容是本轮写入的，已保留草稿并停止。'), { code: 'desktop_chat_draft_preserved' });
  }
  const inspect = actions.findIndex((step, index) => index === multiline || (kind(step) === 'hotkey' && isPaste(step)));
  if (inspect >= 0 && (actions[inspect].submit || actions.slice(inspect + 1).some(step => kind(step) !== 'wait'))) {
    throw Object.assign(new Error('请单独输入多行正文或粘贴附件，查看完整草稿并核对后再发送。'), { code: 'desktop_chat_observation_required' });
  }
  const lastEdit = actions.findLast(step => kind(step) !== 'wait');
  if (lastEdit && ((kind(lastEdit) === 'type' && !lastEdit.submit) || (kind(lastEdit) === 'hotkey' && isPaste(lastEdit)))) return chat;
}

module.exports = { checkChatTarget, confirmedDraftEdit, isEnter };
