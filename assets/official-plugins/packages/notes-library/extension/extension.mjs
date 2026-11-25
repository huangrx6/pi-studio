import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { noteError, NotesError, openNotesStore, SECTIONS } from './notes-store.mjs';

const require = createRequire(import.meta.url);
const sections = SECTIONS.map(section => ({ id: section.id, name: section.name }));
const sectionFilter = { type: 'string', enum: sections.map(section => section.id) };
const relativePath = { type: 'string', description: 'File path relative to the selected Notes Library root.' };

function desktop() {
  const { BrowserWindow, dialog, shell } = require('electron');
  return {
    async chooseDirectory() {
      const parent = BrowserWindow.getFocusedWindow();
      const options = { title: '选择笔记目录', properties: ['openDirectory', 'createDirectory'] };
      const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
      return result.canceled ? null : result.filePaths[0];
    },
    trashItem: file => shell.trashItem(file),
    openPath: file => shell.openPath(file),
    openExternal: url => shell.openExternal(url),
  };
}

function result(value) {
  return { output: [{ type: 'text', text: JSON.stringify(value) }] };
}

function notesTools(store, announce) {
  function tool(name, description, properties, required, run, replay) {
    return {
      name, description, ...(replay && { replay }),
      parameters: { type: 'object', additionalProperties: false, properties, required },
      async execute(args) {
        try { return result(await run(args)); }
        catch (error) { throw noteError(error); }
      },
    };
  }
  return [
    tool('notes_library_list', 'List the configured Notes Library and the actual names of its PARA sections. Read notes-spec.md in the system section for local organization rules.',
      {}, [], async () => {
        const { sections, entries, partial } = await store.tree();
        return { ...store.state(), sections, rootEntries: entries.filter(entry => !entry.parent).slice(0, 100), partial };
      }, 'safe'),
    tool('notes_library_search', 'Search titles and full text in the single configured Notes Library. Optionally limit matching to a PARA section.',
      { query: { type: 'string', minLength: 1, maxLength: 160 }, section: sectionFilter }, ['query'],
      ({ query, section }) => store.search(query, { section }), 'safe'),
    tool('notes_library_read', 'Read a Markdown or HTML file and the revision required to update it. Only paths relative to the selected Notes Library are accepted.',
      { path: relativePath, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 80_000 } },
      ['path'], async ({ path, offset = 0, limit = 80_000 }) => {
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 80_000) {
          throw new NotesError('笔记读取范围无效。');
        }
        const note = await store.read(path);
        const end = offset + limit;
        return { ...note, text: note.text.slice(offset, end), nextOffset: end < note.text.length ? end : null };
      }, 'safe'),
    tool('notes_library_write', 'Create or replace a Markdown or HTML note in the selected Notes Library when the user authorizes the write. Use null revision only for a new file. For an existing file, read its current complete content and pass the returned revision. A conflict preserves the current file and requires a fresh read.',
      { path: relativePath, text: { type: 'string', maxLength: 2_097_152 }, revision: { type: ['string', 'null'] } },
      ['path', 'text', 'revision'], async args => {
        const saved = await store.save(args);
        if (saved.status === 'conflict') throw new NotesError('文件已变化，请重新读取并合并后再保存。');
        announce();
        const { path, revision, modifiedAt } = saved.note;
        return { path, revision, modifiedAt };
      }),
  ];
}

export async function activate({ dataDirectory }, native = desktop) {
  const store = await openNotesStore(dataDirectory);
  const spec = await readFile(new URL('./notes-spec.md', import.meta.url), 'utf8');
  const subscribers = new Set();
  let revision = 0;
  let watcher;
  let debounce;
  let poll;
  let choosing = false;
  const read = () => ({ viewData: { ...store.state(), appearance: store.viewAppearance(), sections, revision } });

  function publish() {
    for (const refresh of subscribers) {
      try { refresh(); } catch { /* The visible view can reconnect independently. */ }
    }
  }
  function announce() {
    store.invalidate();
    revision++;
    publish();
  }
  function stopWatch() {
    watcher?.close();
    clearTimeout(debounce);
    clearInterval(poll);
    watcher = debounce = poll = undefined;
  }
  function startWatch() {
    stopWatch();
    if (!subscribers.size || !store.state().library) return;
    const fallback = () => {
      stopWatch();
      poll = setInterval(announce, 3_500);
      poll.unref?.();
    };
    try {
      watcher = store.watchLibrary(() => {
        clearTimeout(debounce);
        debounce = setTimeout(announce, 150);
      });
      watcher?.once('error', fallback);
    } catch {
      fallback();
    }
  }

  async function invoke(context, method, params = {}) {
    try {
      context.signal?.throwIfAborted();
      const { library, path, query, section } = params || {};
      let changed;
      switch (method) {
        case 'chooseDirectory': {
          if (choosing) return null;
          choosing = true;
          try {
            const directory = await native().chooseDirectory();
            if (!directory) return null;
            context.signal?.throwIfAborted();
            changed = await store.bind(directory);
            startWatch();
          } finally { choosing = false; }
          break;
        }
        case 'tree': return await store.tree(library);
        case 'setAppearance': {
          const settings = await store.setAppearance(params ?? {});
          publish();
          return settings;
        }
        case 'read': return await store.read(path, library);
        case 'readDraft': return await store.readDraft(params);
        case 'writeDraft': return await store.writeDraft(params);
        case 'search': return await store.search(query, { library, section, signal: context.signal });
        case 'backlinks': return await store.backlinks(path, { library, signal: context.signal });
        case 'asset': return await store.asset(params);
        case 'openFile': return await store.openFile(params, target => native().openPath(target));
        case 'openLink': {
          let url;
          try { url = new URL(params.url); } catch { throw new NotesError('链接无效。'); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new NotesError('请选择普通的网页链接。');
          }
          await native().openExternal(url.href);
          return true;
        }
        case 'save': changed = await store.save(params); break;
        case 'create': changed = await store.create(params); break;
        case 'move': changed = await store.move(params); break;
        case 'trash': changed = await store.trash(params, target => native().trashItem(target)); break;
        case 'initialize': changed = await store.initialize(params, spec); break;
        default: throw new NotesError('知识库操作无效。');
      }
      if (changed?.status !== 'conflict') announce();
      return changed;
    } catch (error) {
      throw noteError(error);
    }
  }

  return {
    durableExtension: { name: 'studio.notes-library', tools: notesTools(store, announce) },
    dataSources: {
      'library-data': {
        read,
        subscribe(context, publish) {
          const refresh = () => { if (!context.signal?.aborted) publish(read()); };
          subscribers.add(refresh);
          if (subscribers.size === 1) startWatch();
          refresh();
          return () => {
            subscribers.delete(refresh);
            if (!subscribers.size) stopWatch();
          };
        },
        invoke,
      },
    },
    cleanup() {
      subscribers.clear();
      stopWatch();
    },
  };
}
