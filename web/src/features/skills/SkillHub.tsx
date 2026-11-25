import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Download,
  Folder,
  FolderSearch,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { LoadingIndicator, LoadingState } from '../../shared/LoadingState';
import type {
  SkillCatalogItem,
  SkillHubSnapshot,
  SkillInstallPreview,
  SkillSource,
} from '../../types/global.d';
import { useSettingsToast } from '../../shared/SettingsToast';
import { errorText } from '../../shared/error-text';
import { formatFileSize } from '../../shared/filesize';
import './styles/skill-library.css';
import './styles/skill-hub.css';
import { createSkillInstallSession, type SkillInstallState } from './skill-install-session';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import { Accordion } from '../../shared/Accordion';
import { SkillCatalogDialog } from './SkillCatalogDialog';
import { invocationLabel, skillSourceCatalogs, sourceStatusLabel, sourceTypeLabel } from './skill-catalog';

type WorkspaceOption = { cwd: string; name: string };
type InstallResult = Awaited<ReturnType<typeof window.piApi.installPreparedSkill>>;

type Props = {
  workspace: string;
  workspaces: WorkspaceOption[];
  /** 全局与共享技能的落盘目录，直接显示给用户，避免"按了就不知道装到哪"。 */
  userSkillsPath: string;
  sharedSkillsPath: string;
  onInstalled: (result: InstallResult, cwd: string) => void | Promise<void>;
  onCommitted?: (result: InstallResult, cwd: string) => void;
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void;
};

export function SkillHub(props: Props) {
  return <SkillHubScope key={props.workspace} {...props} />;
}

function SkillHubScope({
  workspace,
  workspaces,
  userSkillsPath,
  sharedSkillsPath,
  onInstalled,
  onCommitted,
  onNotify,
}: Props) {
  const [snapshot, setSnapshot] = useState<SkillHubSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [browse, setBrowse] = useState<{ sourceId?: string } | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [selected, setSelected] = useState<SkillCatalogItem | null>(null);
  const [sourceBusyId, setSourceBusyId] = useState('');
  const live = useRef(true);
  const loadRequest = useRef(0);
  useEffect(() => { live.current = true; return () => { live.current = false; loadRequest.current++; }; }, []);

  async function load(refresh = false, completion?: string) {
    const request = ++loadRequest.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.piApi.skillHub({ refresh });
      if (live.current && request === loadRequest.current) {
        setSnapshot(next);
        if (completion) onNotify(completion, 'success');
      }
    } catch (loadError) {
      if (live.current && request === loadRequest.current) {
        if (snapshot || completion) onNotify(completion ? `${completion}，列表刷新失败。${errorText(loadError)}` : errorText(loadError), 'error');
        else setError(errorText(loadError));
      }
    } finally {
      if (live.current && request === loadRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  const sourceRows = useMemo(() => skillSourceCatalogs(snapshot), [snapshot]);
  const hasSources = Boolean(snapshot?.sources.length);
  const currentCatalog = sourceRows.find(row => row.source.id === browse?.sourceId);
  useEffect(() => {
    if (browse?.sourceId && !currentCatalog) setBrowse(null);
  }, [browse, currentCatalog]);

  async function toggleSource(source: SkillSource, enabled: boolean) {
    setSourceBusyId(source.id);
    setError('');
    try {
      await window.piApi.setSkillSourceEnabled({ id: source.id, enabled });
      await load(true, enabled ? '技能源已启用' : '技能源已停用');
    } catch (toggleError) {
      if (live.current) onNotify(errorText(toggleError), 'error');
    } finally {
      setSourceBusyId('');
    }
  }

  async function removeSource(source: SkillSource) {
    setSourceBusyId(source.id);
    setError('');
    try {
      await window.piApi.removeSkillSource(source.id);
      await load(true, `已移除技能源「${source.name}」`);
    } catch (removeError) {
      if (live.current) onNotify(errorText(removeError), 'error');
    } finally {
      setSourceBusyId('');
    }
  }

  return <section className="skill-hub-card" aria-label="技能源">
    <header className="skill-library-heading">
      <h2>技能源{hasSources && <span>{sourceRows.length}</span>}</h2>
      {hasSources && <div className="skill-hub-actions">
        <button type="button" className="skill-library-action" aria-haspopup="dialog" onClick={() => setBrowse({})}>
          <Search aria-hidden="true" />搜索技能
        </button>
        <button type="button" className="skill-library-action" aria-haspopup="dialog" onClick={() => setManagerOpen(true)}>
          <Settings2 aria-hidden="true" />管理源
        </button>
        <button type="button" className="icon-button" aria-label="刷新技能源" title="刷新技能源" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw aria-hidden="true" className={loading ? 'spin' : ''} />
        </button>
      </div>}
    </header>

    {loading && !snapshot ? <LoadingState variant="section">正在读取技能源…</LoadingState>
      : !snapshot && error ? <div className="skill-hub-empty is-error" role="alert">
        <div><strong>无法读取技能源</strong><p>{error}</p></div>
        <button type="button" className="settings-outline" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw />重新加载
        </button>
      </div>
      : !snapshot?.sources.length ? <div className="plugin-hub-empty">
        <span className="plugin-hub-empty-mark" aria-hidden="true"><BookOpen /></span>
        <h3>还没有技能源</h3>
        <p>添加 GitHub 仓库、本地目录或清单后，即可浏览并安装其中的技能。</p>
        <div className="plugin-hub-empty-actions">
          <button type="button" className="settings-outline" onClick={() => setManagerOpen(true)}><Plus aria-hidden="true" />添加技能源</button>
        </div>
      </div>
      : <div className="skill-library-list skill-hub-overview" role="group" aria-label="技能源列表">
        {sourceRows.map(({ source, count }) => <button
          type="button"
          key={source.id}
          className="skill-hub-overview-row"
          aria-haspopup="dialog"
          aria-label={`浏览技能源 ${source.name}`}
          onClick={() => setBrowse({ sourceId: source.id })}
        >
          <span className="skill-hub-source-icon" aria-hidden="true">{source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
          <span className="skill-hub-overview-copy">
            <strong>{source.name}</strong>
            <small>{sourceTypeLabel(source)}</small>
          </span>
          <span className="skill-hub-source-status" data-error={source.enabled && !loading && Boolean(source.lastError)}>
            {sourceStatusLabel(source, count, loading)}
          </span>
          <ChevronRight aria-hidden="true" />
        </button>)}
      </div>}

    {browse && (!browse.sourceId || currentCatalog) && <SkillCatalogDialog
      catalog={currentCatalog}
      catalogs={sourceRows}
      error={error}
      refreshing={loading}
      onRefresh={() => void load(true)}
      onManage={() => setManagerOpen(true)}
      onSelect={setSelected}
      onClose={() => setBrowse(null)}
    />}

    {managerOpen && <SkillSourceManager
      snapshot={snapshot}
      refreshing={loading}
      busyId={sourceBusyId}
      onClose={() => setManagerOpen(false)}
      onChange={() => load(false, '技能源已添加')}
      onToggle={toggleSource}
      onRemove={removeSource}
    />}
    {selected && <SkillInstallPreviewDialog
      key={selected.id}
      item={selected}
      workspace={workspace}
      workspaces={workspaces}
      userSkillsPath={userSkillsPath}
      sharedSkillsPath={sharedSkillsPath}
      onClose={() => setSelected(null)}
      onCommitted={onCommitted}
      onInstalled={async (result, cwd) => {
        await onInstalled(result, cwd);
        if (live.current) void load(true);
      }}
    />}
  </section>;
}

function SkillSourceManager({
  snapshot,
  refreshing,
  busyId,
  onClose,
  onChange,
  onToggle,
  onRemove,
}: {
  snapshot: SkillHubSnapshot | null;
  refreshing: boolean;
  busyId: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onToggle: (source: SkillSource, enabled: boolean) => Promise<void>;
  onRemove: (source: SkillSource) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<SkillSource['type']>('github');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const showToast = useSettingsToast();

  async function pick() {
    try {
      const value = type === 'directory'
        ? await window.piApi.pickSkillSourceDirectory()
        : await window.piApi.pickSkillRegistryFile();
      if (value) setLocation(value);
    } catch (pickError) {
      showToast(errorText(pickError), 'error');
    }
  }

  async function add() {
    if (!location.trim() || busy) return;
    setBusy(true);
    try {
      await window.piApi.addSkillSource({
        name: name.trim() || undefined,
        type,
        location: location.trim(),
      });
      await onChange();
      setName('');
      setLocation('');
    } catch (addError) {
      showToast(errorText(addError), 'error');
    } finally {
      setBusy(false);
    }
  }

  return <SettingsDialog
    wide
    className="plugin-form-dialog"
    title="管理技能源"
    description="添加 GitHub 仓库、本地目录或 JSON 目录清单作为技能来源。"
    action="添加源"
    busyAction="正在添加…"
    busy={busy || Boolean(busyId)}
    loading={false}
    unavailable={!location.trim()}
    error={null}
    onClose={onClose}
    onSubmit={() => void add()}
  >
    <div className="plugin-flat-form">
      <section className="plugin-flat-section" aria-label="添加技能源">
        <h3>添加来源</h3>
        <div className="skill-source-form">
          <label>类型
            <Select
              label="技能源类型"
              value={type}
              onChange={(value) => {
                setType(value as SkillSource['type']);
              }}
              options={[
                { value: 'github', label: 'GitHub 仓库' },
                { value: 'directory', label: '本地目录' },
                { value: 'registry', label: '技能目录（JSON）' },
              ]}
            />
          </label>
          <label>显示名称<input value={name} aria-label="显示名称" onChange={(event) => setName(event.target.value)} placeholder="可选" /></label>
          <label className="field-wide">位置
            <div className="skill-source-location">
              <input
                aria-label="位置"
                value={location}
                onChange={(event) => {
                  const value = event.target.value;
                  setLocation(value);
                  if (/^https:\/\/github\.com\/[^/]+\/[^/?#]+\/?(?:[?#].*)?$/i.test(value.trim())) setType('github');
                }}
                placeholder={type === 'github' ? 'https://github.com/anthropics/skills' : type === 'directory' ? '/path/to/skills' : 'https://skills.internal/catalog.json'}
              />
              {type !== 'github' && <button type="button" className="settings-outline" onClick={() => void pick()}><FolderSearch />选择</button>}
            </div>
          </label>
          {/* 说明放在 label 外面，否则会被算进“位置”输入框的无障碍名字。 */}
          {type === 'registry' && <small className="skill-source-hint field-wide">
            支持两种 JSON：带 sha256 的压缩包清单（schemaVersion 1），以及只有名称、说明和地址的链接清单（无版本号或 schemaVersion 2）。
          </small>}
        </div>
      </section>
      <section className="plugin-flat-section skill-source-existing" aria-label="已添加技能源">
        <div className="plugin-flat-section-head">
          <h3>已添加</h3>
          <span>{snapshot?.sources.length || 0} 个</span>
        </div>
        <div className="skill-source-list" tabIndex={snapshot && snapshot.sources.length > 4 ? 0 : undefined} role="group" aria-label="技能源列表">
          {snapshot?.sources.map((source) => <div className="skill-source-row" key={source.id}>
            <span className="skill-source-row-icon">{source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
            <span className="skill-source-row-copy">
              <strong>{source.name}</strong>
              <small>{sourceTypeLabel(source)} · {sourceStatusLabel(source, source.itemCount, refreshing)}{source.lastSyncedAt ? ` · ${new Date(source.lastSyncedAt).toLocaleString()}` : ''}</small>
              <code title={source.location}>{source.location}</code>
              {source.enabled && source.lastError && <small role="alert">{source.lastError}</small>}
            </span>
            <button
              type="button"
              className={`switch ${source.enabled ? 'is-on' : ''}`}
              role="switch"
              aria-checked={source.enabled}
              disabled={Boolean(busyId)}
              aria-label={`${source.enabled ? '停用' : '启用'}技能源 ${source.name}`}
              onClick={() => void onToggle(source, !source.enabled)}
            ><span /></button>
            <button
              type="button"
              className="icon-button resource-delete"
              aria-label={`移除技能源 ${source.name}`}
              title="只移除源配置，不删除已安装技能"
              disabled={Boolean(busyId)}
              onClick={() => void onRemove(source)}
            ><Trash2 /></button>
          </div>)}
          {!snapshot?.sources.length && <div className="settings-empty settings-empty--small">还没有源。</div>}
        </div>
      </section>
    </div>
  </SettingsDialog>;
}

/**
 * Installation is two-phase: the preview token stages and validates files, and
 * only the confirm action writes to the selected scope. Project-scoped installs
 * target cwd/.pi-studio/skills; user-scoped installs live under Electron userData.
 */
function SkillInstallPreviewDialog({
  item,
  workspace,
  workspaces,
  userSkillsPath,
  sharedSkillsPath,
  onClose,
  onInstalled,
  onCommitted,
}: {
  item: SkillCatalogItem;
  workspace: string;
  workspaces: WorkspaceOption[];
  userSkillsPath: string;
  sharedSkillsPath: string;
  onClose: () => void;
  onInstalled: (result: InstallResult, cwd: string) => void | Promise<void>;
  onCommitted?: (result: InstallResult, cwd: string) => void;
}) {
  const showToast = useSettingsToast();
  const [scope, setScope] = useState<SkillInstallPreview['scope']>('user');
  const [targetWorkspace, setTargetWorkspace] = useState(workspace || workspaces[0]?.cwd || '');
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [installState, setInstallState] = useState<SkillInstallState>({ busy: false, attempted: false, result: null, error: '', complete: false });
  const installing = installState.busy;
  const committed = Boolean(installState.result);
  const live = useRef(true);
  const callbacks = useRef({ onInstalled, onCommitted, onClose });
  callbacks.current = { onInstalled, onCommitted, onClose };
  const sessionRef = useRef<ReturnType<typeof createSkillInstallSession> | null>(null);
  const makeSession = () => createSkillInstallSession({
    install: payload => window.piApi.installPreparedSkill(payload),
    refresh: cwd => window.piApi.refreshSkills(cwd),
    onCommitted: (result, cwd) => callbacks.current.onCommitted?.(result, cwd),
    onInstalled: (result, cwd) => callbacks.current.onInstalled(result, cwd),
    onChange: state => {
      if (!live.current) return;
      setInstallState(state);
      if (state.error && !state.busy) showToast(state.error, 'error');
      if (state.complete) callbacks.current.onClose();
    },
  });
  if (!sessionRef.current) sessionRef.current = makeSession();
  const tokenRef = useRef('');
  const requestRef = useRef(0);

  async function prepare(nextScope = scope, nextWorkspace = targetWorkspace) {
    if (sessionRef.current?.state.busy || sessionRef.current?.state.result) return;
    sessionRef.current?.dispose();
    sessionRef.current = makeSession();
    setInstallState(sessionRef.current.state);
    const request = ++requestRef.current;
    const previousToken = tokenRef.current;
    tokenRef.current = '';
    if (previousToken) void window.piApi.disposePreparedSkill(previousToken).catch(() => {});
    setLoading(true);
    setPreview(null);
    try {
      const result = await window.piApi.prepareSkillInstall({
        sourceId: item.sourceId,
        listingId: item.listingId,
        scope: nextScope,
        cwd: nextScope === 'project' ? nextWorkspace : workspace,
      });
      if (!live.current || request !== requestRef.current) {
        void window.piApi.disposePreparedSkill(result.token).catch(() => {});
        return;
      }
      tokenRef.current = result.token;
      setPreview(result);
    } catch (prepareError) {
      if (live.current && request === requestRef.current) showToast(errorText(prepareError), 'error');
    } finally {
      if (live.current && request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    live.current = true;
    void prepare();
    return () => {
      live.current = false;
      sessionRef.current?.dispose();
      requestRef.current += 1;
      if (tokenRef.current) void window.piApi.disposePreparedSkill(tokenRef.current).catch(() => {});
    };
  }, []);

  function changeScope(next: SkillInstallPreview['scope']) {
    if (sessionRef.current?.state.busy || sessionRef.current?.state.result || loading || next === scope || (next === 'project' && !targetWorkspace)) return;
    setScope(next);
    void prepare(next, targetWorkspace);
  }

  function changeWorkspace(next: string) {
    if (sessionRef.current?.state.busy || sessionRef.current?.state.result || loading) return;
    setTargetWorkspace(next);
    if (scope === 'project') void prepare('project', next);
  }

  function close() {
    if (sessionRef.current?.state.busy) return;
    live.current = false;
    sessionRef.current?.dispose();
    requestRef.current++;
    onClose();
  }

  async function install() {
    const session = sessionRef.current;
    if (!session || session.state.busy) return;
    if (session.state.result) { await session.retry(); return; }
    if (session.state.attempted) { await prepare(); return; }
    if (!preview) { await prepare(); return; }
    if (!tokenRef.current) return;
    const token = tokenRef.current;
    tokenRef.current = '';
    await session.install(token, preview.scope === 'project' ? targetWorkspace : workspace);
    // A precommit failure can leave staging behind; never reuse that token.
    if (!session.state.result) void window.piApi.disposePreparedSkill(token).catch(() => {});
  }

  const version = preview?.version ?? item.version;
  const sourceName = preview?.sourceName ?? item.sourceName;

  return <DetailDialog className="skill-install-dialog" onClose={close}>
    <header className="detail-header">
      <div className="detail-heading skill-install-heading">
        <h2>{item.name}</h2>
        <p>{sourceName} · {version ? `v${version}` : '未声明版本'}</p>
      </div>
      <button type="button" className="icon-button" aria-label="关闭技能预览" disabled={installing} onClick={close}><X aria-hidden="true" /></button>
    </header>
    <div className="skill-install-body">
      {loading ? <LoadingState variant="section">正在准备技能预览…</LoadingState>
        : preview && <>
          {preview.description && <p className="skill-install-description">{preview.description}</p>}
          <dl className="skill-install-overview">
            <div><dt>调用</dt><dd>{invocationLabel(preview.invocation)}</dd></div>
            <div><dt>提示词</dt><dd>~{preview.promptTokens} tokens/请求</dd></div>
            <div><dt>资源</dt><dd>{preview.resourceCount} 个 · {formatFileSize(preview.totalBytes)}</dd></div>
          </dl>
          <section className="skill-install-scope">
            <div className="skill-install-scope-row">
              <div className="skill-install-scope-heading">
                <h3>安装范围</h3>
                <InfoHint label="全局技能写入 Studio 应用数据目录。共享技能写入 ~/.agents/skills，与其他 Agent 工具共用。项目技能写入所选工作区的 .pi-studio/skills，只对该工作区生效。" />
              </div>
              <div className="settings-segments skill-install-scope-options" role="group" aria-label="安装范围">
                <button type="button" disabled={installing || committed} aria-pressed={scope === 'user'} onClick={() => changeScope('user')} title="Studio 应用数据目录，只对本应用生效">全局</button>
                <button type="button" disabled={installing || committed} aria-pressed={scope === 'shared'} onClick={() => changeScope('shared')} title="~/.agents/skills，与其他 Agent 工具共用">共享</button>
                <button type="button" disabled={installing || committed || !workspaces.length} aria-pressed={scope === 'project'} onClick={() => changeScope('project')}>项目</button>
              </div>
            </div>
            {scope === 'project' && <Select
              disabled={installing || committed}
              label="项目技能工作区"
              value={targetWorkspace}
              options={workspaces.map((entry) => ({ value: entry.cwd, label: entry.name || entry.cwd, description: entry.cwd }))}
              onChange={changeWorkspace}
              leadingIcon={<Folder />}
            />}
            <code className="skill-install-scope-path">{
              scope === 'project'
                ? targetWorkspace
                : scope === 'shared' ? sharedSkillsPath : userSkillsPath
            }</code>
          </section>
          <Accordion compact className="skill-install-files" summary="文件预览" badge={`${preview.files.length} 个文件`} defaultOpen={preview.files.length <= 5}>
            <div className="skill-install-file-list" tabIndex={preview.files.length > 5 ? 0 : undefined} role="group" aria-label="技能文件列表">
              {preview.files.map((file) => <div key={file.path}><code>{file.path}</code><span>{formatFileSize(file.size)}</span></div>)}
            </div>
            <p className="skill-install-file-hash">SHA-256 {preview.sha256.slice(0, 12)}…</p>
          </Accordion>
          {preview.requiresTrust && <div className="skill-install-note"><CheckCircle2 aria-hidden="true" />安装后仍需在技能列表信任项目内容，之后才会进入下一次模型请求。</div>}
        </>}
    </div>
    <footer className="detail-footer">
      {preview?.canUpdate && <small className="skill-install-update-note">将更新已安装的 v{preview.installedVersion}</small>}
      <div className="skill-install-footer-actions">
        <button type="button" className="settings-outline" disabled={installing} onClick={close}>{committed ? '关闭' : '取消'}</button>
        <button type="button" className="settings-save" disabled={loading || installing} onClick={() => void install()}>
          {installing ? <LoadingIndicator /> : <Download aria-hidden="true" />}
          {installing ? committed ? '正在恢复…' : '正在安装…' : committed ? installState.result?.projection.status === 'error' ? '重试刷新' : '重试页面更新' : installState.attempted || !preview ? '重新预览' : preview?.canUpdate ? '更新技能' : '安装技能'}
        </button>
      </div>
    </footer>
  </DetailDialog>;
}
