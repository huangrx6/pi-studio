import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Download,
  FileCode2,
  Folder,
  FolderSearch,
  Globe2,
  Layers3,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  SkillCatalogItem,
  SkillHubSnapshot,
  SkillInstallPreview,
  SkillSource,
} from '../../global.d';
import { errorText } from '../../shared/error-text';
import { formatFileSize } from '../../shared/filesize';
import './skill-hub.css';
import { DetailDialog } from '../../shared/DetailDialog';
import { InfoHint } from '../../shared/InfoHint';
import { Select } from '../../shared/Select';
import { SettingsDialog } from '../../shared/SettingsDialog';
import {
  SettingsResourceCard,
  SettingsResourceCardBody,
  SettingsResourceCardFooter,
  SettingsResourceCardIcon,
  SettingsResourceCardMain,
} from '../../shared/SettingsResourceCard';

/** 一个源里可能有上百个技能：先渲染一页，其余按需展开。 */
const SKILL_PAGE_SIZE = 24;

type WorkspaceOption = { cwd: string; name: string };
type InstallResult = Awaited<ReturnType<typeof window.piApi.installPreparedSkill>>;

type Props = {
  workspace: string;
  workspaces: WorkspaceOption[];
  onInstalled: (result: InstallResult) => void;
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void;
};

function sourceTypeLabel(source: Pick<SkillSource, 'type'>) {
  return source.type === 'github' ? 'GitHub 仓库' : source.type === 'directory' ? '本地目录' : '技能目录（JSON）';
}

function invocationLabel(value: SkillCatalogItem['invocation']) {
  return value === 'explicit' ? '仅 /skill 显式调用' : '模型可按描述发现';
}

export function SkillHub({
  workspace,
  workspaces,
  onInstalled,
  onNotify,
}: Props) {
  const [snapshot, setSnapshot] = useState<SkillHubSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);
  const [selected, setSelected] = useState<SkillCatalogItem | null>(null);
  const [sourceBusyId, setSourceBusyId] = useState('');
  /** 左侧源导航选中的源；'all' 是源总览。 */
  const [activeSource, setActiveSource] = useState('all');
  /** 单个源按需渲染的卡片数：一个源可能有上百个技能。 */
  const [visibleCount, setVisibleCount] = useState(SKILL_PAGE_SIZE);

  async function load(refresh = false) {
    setLoading(true);
    setError('');
    try {
      setSnapshot(await window.piApi.skillHub({ refresh }));
    } catch (loadError) {
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
  }, []);

  const needle = query.trim().toLocaleLowerCase();
  const catalogs = useMemo(() => snapshot?.catalogs || [], [snapshot]);
  const total = catalogs.reduce((count, catalog) => count + catalog.items.length, 0);
  /** 搜索永远跨全部技能源，不受左侧选中项限制。 */
  const matches = useMemo(() => (needle
    ? catalogs.flatMap((catalog) => catalog.items.filter((item) => (
      `${item.name} ${item.description} ${item.sourceName}`.toLocaleLowerCase().includes(needle)
    )))
    : []), [catalogs, needle]);
  /** 导航与总览都以 sources 为准：停用或读取失败的源也要能看见、能重新启用。 */
  const sourceRows = useMemo(() => (snapshot?.sources || []).map((source) => {
    const catalog = catalogs.find((entry) => entry.source.id === source.id);
    return {
      source,
      items: catalog?.items || [],
      diagnostics: catalog?.diagnostics || [],
      count: catalog ? catalog.items.length : source.itemCount,
    };
  }), [catalogs, snapshot]);
  const activeRow = activeSource === 'all'
    ? undefined
    : sourceRows.find((row) => row.source.id === activeSource);

  useEffect(() => {
    if (activeSource !== 'all' && snapshot && !snapshot.sources.some((source) => source.id === activeSource)) {
      setActiveSource('all');
    }
  }, [activeSource, snapshot]);

  useEffect(() => {
    setVisibleCount(SKILL_PAGE_SIZE);
  }, [activeSource, needle]);

  async function toggleSource(source: SkillSource, enabled: boolean) {
    setSourceBusyId(source.id);
    setError('');
    try {
      await window.piApi.setSkillSourceEnabled({ id: source.id, enabled });
      await load(true);
    } catch (toggleError) {
      setError(errorText(toggleError));
    } finally {
      setSourceBusyId('');
    }
  }

  async function removeSource(source: SkillSource) {
    setSourceBusyId(source.id);
    setError('');
    try {
      await window.piApi.removeSkillSource(source.id);
      await load(true);
      onNotify(`已移除技能源「${source.name}」`, 'success');
    } catch (removeError) {
      setError(errorText(removeError));
    } finally {
      setSourceBusyId('');
    }
  }

  /** 一张技能卡：搜索结果与单个源共用。 */
  function renderGrid(items: SkillCatalogItem[]) {
    return <div className="skill-hub-grid">
      {items.map((item) => <SettingsResourceCard className="skill-hub-item" key={item.id}>
        <SettingsResourceCardMain className="skill-hub-item-main" onClick={() => setSelected(item)} ariaLabel={`查看技能 ${item.name}`}>
          <SettingsResourceCardIcon className="skill-hub-item-icon"><FileCode2 /></SettingsResourceCardIcon>
          <SettingsResourceCardBody className="skill-hub-item-body">
            <span className="skill-hub-item-title"><strong>{item.name}</strong>{item.version ? <small>v{item.version}</small> : null}</span>
            <p>{item.description}</p>
            <span className="skill-hub-item-meta">
              <span>{invocationLabel(item.invocation)}</span>
              {item.resourceCount != null && <span>{item.resourceCount} 个资源</span>}
              <span>~{item.promptTokens} tokens/请求</span>
            </span>
          </SettingsResourceCardBody>
        </SettingsResourceCardMain>
        <SettingsResourceCardFooter className="skill-hub-item-footer">
          <span className={`skill-hub-state ${item.updateAvailable ? 'is-update' : item.installed ? 'is-installed' : ''}`}>
            {item.updateAvailable ? `可更新 · ${item.installedVersion} → ${item.version}` : item.installed ? `已安装 · v${item.installedVersion}` : '可安装'}
          </span>
          <button type="button" className="settings-text-button" onClick={() => setSelected(item)}>
            {item.updateAvailable ? '查看更新' : item.installed ? '查看详情' : '预览安装'}
          </button>
        </SettingsResourceCardFooter>
      </SettingsResourceCard>)}
    </div>;
  }

  return <section className="settings-card skill-hub-card">
    <div className="settings-card-head skill-hub-head">
      <div>
        <h2>技能源 <span className="count-badge">{needle ? `${matches.length} / ${total}` : total}</span></h2>
      </div>
      <div className="skill-hub-actions">
        <div className="skill-hub-search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索技能源"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能…"
          />
          {query && <button type="button" aria-label="清除技能搜索" onClick={() => setQuery('')}><X /></button>}
        </div>
        <button type="button" className="settings-outline" onClick={() => setManagerOpen(true)}>
          <Settings2 />管理源
        </button>
        <button type="button" className="settings-outline" disabled={loading} onClick={() => void load(true)}>
          <RefreshCw className={loading ? 'spin' : ''} />刷新
        </button>
      </div>
    </div>

    {error && <div className="settings-error skill-hub-error" role="alert">{error}</div>}
    {loading && !snapshot ? <div className="skill-hub-loading" role="status"><LoaderCircle className="spin" />正在读取技能源…</div>
      : !snapshot?.sources.length ? <div className="skill-hub-empty">
        <span><Globe2 /></span>
        <div><strong>还没有技能源</strong></div>
        <button type="button" className="settings-add-button" onClick={() => setManagerOpen(true)}><Plus />添加技能源</button>
      </div>
      : <div className="skill-hub-body">
        {/* 源多时先按源收敛：左边选源，右边只看一个源的内容。 */}
        <nav className="skill-hub-sources" aria-label="技能源列表">
          <button
            type="button"
            className="skill-hub-source-tab"
            aria-current={activeSource === 'all' ? 'true' : undefined}
            onClick={() => setActiveSource('all')}
          >
            <span className="skill-hub-source-tab-icon"><Layers3 /></span>
            <span className="skill-hub-source-tab-name">全部技能</span>
            <span className="skill-hub-source-tab-count">{total}</span>
          </button>
          {sourceRows.map((row) => <button
            type="button"
            key={row.source.id}
            className="skill-hub-source-tab"
            title={row.source.lastError || row.source.location}
            aria-current={activeSource === row.source.id ? 'true' : undefined}
            data-disabled={row.source.enabled ? undefined : 'true'}
            onClick={() => setActiveSource(row.source.id)}
          >
            <span className="skill-hub-source-tab-icon">{row.source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
            <span className="skill-hub-source-tab-name">{row.source.name}</span>
            <span className="skill-hub-source-tab-count">{row.count}</span>
            {row.source.lastError ? <i className="skill-hub-source-tab-alert" aria-label="读取失败" /> : null}
          </button>)}
        </nav>

        <div className="skill-hub-content">
          {needle ? (matches.length > 0
            ? <>
              <p className="skill-hub-scope-note" role="status">在全部技能源中搜索“{query.trim()}” · {matches.length} 个匹配</p>
              {renderGrid(matches)}
            </>
            : <div className="settings-empty settings-empty--small" role="status">
              没有匹配“{query.trim()}”的技能。<button type="button" className="settings-text-button" onClick={() => setQuery('')}>清除搜索</button>
            </div>)
            : activeRow
              ? <>
                <header className="skill-hub-detail-head">
                  <span className="skill-hub-source-icon">{activeRow.source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
                  <div>
                    <strong>{activeRow.source.name}</strong>
                    <span>{sourceTypeLabel(activeRow.source)} · {activeRow.count} 个技能
                      {activeRow.items.some((item) => item.installed) ? ` · ${activeRow.items.filter((item) => item.installed).length} 个已安装` : ''}
                      {activeRow.source.enabled ? '' : ' · 已停用'}
                    </span>
                  </div>
                  <code title={activeRow.source.location}>{activeRow.source.location}</code>
                </header>
                {activeRow.diagnostics.length > 0 && <div className="skill-hub-diagnostics">
                  {activeRow.diagnostics.map((item, index) => <div key={`${item.path}:${index}`}><code>{item.path}</code><span>{item.message}</span></div>)}
                </div>}
                {activeRow.source.lastError && activeRow.items.length === 0 && <div className="settings-empty settings-empty--small" role="alert">{activeRow.source.lastError}</div>}
                {activeRow.items.length > 0
                  ? renderGrid(activeRow.items.slice(0, visibleCount))
                  : <div className="settings-empty settings-empty--small">这个源没有可安装技能。</div>}
                {activeRow.items.length > visibleCount && <button
                  type="button"
                  className="skill-hub-more"
                  onClick={() => setVisibleCount((count) => count + SKILL_PAGE_SIZE)}
                >显示更多（还有 {activeRow.items.length - visibleCount} 个）</button>}
              </>
              : <div className="skill-hub-overview">
                {sourceRows.map((row) => <button
                  type="button"
                  className="skill-hub-overview-row"
                  key={row.source.id}
                  onClick={() => setActiveSource(row.source.id)}
                >
                  <span className="skill-hub-source-icon">{row.source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
                  <span className="skill-hub-overview-copy">
                    <strong>{row.source.name}</strong>
                    <small>{sourceTypeLabel(row.source)} · {row.count} 个技能{row.source.enabled ? '' : ' · 已停用'}</small>
                    {row.items.length > 0 && <span className="skill-hub-overview-samples">
                      {row.items.slice(0, 3).map((item) => item.name).join(' · ')}{row.items.length > 3 ? ' …' : ''}
                    </span>}
                  </span>
                  {row.source.lastError
                    ? <span className="skill-hub-overview-error">读取失败</span>
                    : <ChevronRight aria-hidden="true" />}
                </button>)}
              </div>}
        </div>
      </div>}

    {snapshot?.sources.some((source) => source.lastError) && <div className="skill-hub-source-errors">
      {snapshot.sources.filter((source) => source.lastError).map((source) => <div key={source.id}><strong>{source.name}</strong><span>{source.lastError}</span></div>)}
    </div>}

    {managerOpen && <SkillSourceManager
      snapshot={snapshot}
      busyId={sourceBusyId}
      sourceError={error}
      onClose={() => setManagerOpen(false)}
      onChange={async () => {
        setSnapshot(await window.piApi.skillHub());
        setError('');
      }}
      onToggle={toggleSource}
      onRemove={removeSource}
    />}
    {selected && <SkillInstallPreviewDialog
      item={selected}
      workspace={workspace}
      workspaces={workspaces}
      onClose={() => setSelected(null)}
      onInstalled={(result) => {
        onInstalled(result);
        setSelected(null);
        void load(true);
      }}
    />}
  </section>;
}

function SkillSourceManager({
  snapshot,
  busyId,
  sourceError,
  onClose,
  onChange,
  onToggle,
  onRemove,
}: {
  snapshot: SkillHubSnapshot | null;
  busyId: string;
  sourceError: string;
  onClose: () => void;
  onChange: () => Promise<void>;
  onToggle: (source: SkillSource, enabled: boolean) => Promise<void>;
  onRemove: (source: SkillSource) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<SkillSource['type']>('github');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick() {
    setError('');
    try {
      const value = type === 'directory'
        ? await window.piApi.pickSkillSourceDirectory()
        : await window.piApi.pickSkillRegistryFile();
      if (value) setLocation(value);
    } catch (pickError) {
      setError(errorText(pickError));
    }
  }

  async function add() {
    if (!location.trim() || busy) return;
    setBusy(true);
    setError('');
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
      setError(errorText(addError));
    } finally {
      setBusy(false);
    }
  }

  return <SettingsDialog
    title="管理技能源"
    action="添加源"
    busyAction="正在添加…"
    busy={busy || Boolean(busyId)}
    loading={false}
    unavailable={!location.trim()}
    error={error || (busy ? '' : sourceError)}
    onClose={onClose}
    onSubmit={() => void add()}
    showBackdrop={false}
  >
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
      {type === 'registry' && <small className="skill-source-hint">
        支持两种 JSON：带 sha256 的压缩包清单（schemaVersion 1），以及只有名称、说明和地址的链接清单（无版本号或 schemaVersion 2）。
      </small>}
    </div>
    <div className="skill-source-existing">
      <header><strong>已添加</strong><span>{snapshot?.sources.length || 0} 个</span></header>
      {snapshot?.sources.map((source) => <div className="skill-source-row" key={source.id}>
        <span className="skill-source-row-icon">{source.type === 'directory' ? <Folder /> : <Globe2 />}</span>
        <span className="skill-source-row-copy">
          <strong>{source.name}</strong>
          <small>{sourceTypeLabel(source)} · {source.itemCount} 个技能{source.lastSyncedAt ? ` · ${new Date(source.lastSyncedAt).toLocaleString()}` : ''}</small>
          <code title={source.location}>{source.location}</code>
          {source.lastError && <small role="alert">{source.lastError}</small>}
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
  onClose,
  onInstalled,
}: {
  item: SkillCatalogItem;
  workspace: string;
  workspaces: WorkspaceOption[];
  onClose: () => void;
  onInstalled: (result: InstallResult) => void;
}) {
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [targetWorkspace, setTargetWorkspace] = useState(workspace || workspaces[0]?.cwd || '');
  const [preview, setPreview] = useState<SkillInstallPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const tokenRef = useRef('');
  const requestRef = useRef(0);

  async function prepare(nextScope = scope, nextWorkspace = targetWorkspace) {
    const request = ++requestRef.current;
    const previousToken = tokenRef.current;
    tokenRef.current = '';
    if (previousToken) void window.piApi.disposePreparedSkill(previousToken).catch(() => {});
    setLoading(true);
    setError('');
    setPreview(null);
    try {
      const result = await window.piApi.prepareSkillInstall({
        sourceId: item.sourceId,
        listingId: item.listingId,
        scope: nextScope,
        cwd: nextScope === 'project' ? nextWorkspace : workspace,
      });
      if (request !== requestRef.current) {
        void window.piApi.disposePreparedSkill(result.token).catch(() => {});
        return;
      }
      tokenRef.current = result.token;
      setPreview(result);
    } catch (prepareError) {
      if (request === requestRef.current) setError(errorText(prepareError));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    void prepare();
    return () => {
      requestRef.current += 1;
      if (tokenRef.current) void window.piApi.disposePreparedSkill(tokenRef.current).catch(() => {});
    };
  }, []);

  function changeScope(next: 'user' | 'project') {
    if (installing || loading || next === scope || (next === 'project' && !targetWorkspace)) return;
    setScope(next);
    void prepare(next, targetWorkspace);
  }

  function changeWorkspace(next: string) {
    if (installing || loading) return;
    setTargetWorkspace(next);
    if (scope === 'project') void prepare('project', next);
  }

  async function install() {
    if (!preview || installing) return;
    setInstalling(true);
    setError('');
    try {
      const result = await window.piApi.installPreparedSkill({
        token: preview.token,
        cwd: preview.scope === 'project' ? targetWorkspace : workspace,
      });
      tokenRef.current = '';
      onInstalled(result);
    } catch (installError) {
      setError(errorText(installError));
    } finally {
      setInstalling(false);
    }
  }

  return <DetailDialog className="skill-install-dialog" onClose={() => { if (!installing) onClose(); }}>
    <header className="detail-header">
      <div className="detail-heading">
        <span className="detail-icon is-skill"><Download /></span>
        <div><h2>{item.name}</h2><p>{item.sourceName}{item.version ? ` · v${item.version}` : ' · 链接型技能'}</p></div>
      </div>
      <button type="button" className="icon-button" aria-label="关闭技能预览" disabled={installing} onClick={onClose}><X /></button>
    </header>
    <div className="skill-install-body">
      {error && <div className="settings-error" role="alert">{error}</div>}
      {loading ? <div className="skill-hub-loading" role="status"><LoaderCircle className="spin" />正在准备技能预览…</div>
        : preview && <>
          <section className="skill-install-overview">
            <div><span>来源</span><strong>{preview.sourceName}</strong></div>
            <div><span>版本</span><strong>{preview.version ? `v${preview.version}` : '未声明'}</strong></div>
            <div><span>调用</span><strong>{invocationLabel(preview.invocation)}</strong></div>
            <div><span>提示词</span><strong>~{preview.promptTokens} tokens/请求</strong></div>
            <div><span>资源</span><strong>{preview.resourceCount} 个 · {formatFileSize(preview.totalBytes)}</strong></div>
          </section>
          <p className="skill-install-description">{preview.description}</p>
          <section className="skill-install-scope">
            <div className="skill-install-scope-heading">
              <strong>安装范围</strong>
              <InfoHint align="end" label="全局技能写入 Studio 应用数据目录；项目技能写入所选工作区的 .pi-studio/skills，只对该工作区生效。" />
            </div>
            <div className="skill-install-scope-options">
              <button type="button" disabled={installing} aria-pressed={scope === 'user'} className={scope === 'user' ? 'is-active' : ''} onClick={() => changeScope('user')}>全局</button>
              <button type="button" disabled={installing || !workspaces.length} aria-pressed={scope === 'project'} className={scope === 'project' ? 'is-active' : ''} onClick={() => changeScope('project')}>项目</button>
            </div>
            {scope === 'project' && <Select
              disabled={installing}
              label="项目技能工作区"
              value={targetWorkspace}
              options={workspaces.map((entry) => ({ value: entry.cwd, label: entry.name || entry.cwd, description: entry.cwd }))}
              onChange={changeWorkspace}
              leadingIcon={<Folder />}
            />}
          </section>
          <section className="skill-install-files">
            <header><strong>文件预览</strong><span>{preview.files.length} 个文件 · SHA-256 {preview.sha256.slice(0, 12)}…</span></header>
            {preview.files.map((file) => <div key={file.path}><code>{file.path}</code><span>{formatFileSize(file.size)}</span></div>)}
          </section>
          {preview.requiresTrust && <div className="skill-install-note"><CheckCircle2 />安装后仍需在技能列表信任项目内容，之后才会进入下一次模型请求。</div>}
        </>}
    </div>
    <footer className="detail-footer">
      <span>{preview?.canUpdate ? `将更新已安装的 v${preview.installedVersion}` : ''}</span>
      <button type="button" className="settings-outline" disabled={installing} onClick={onClose}>取消</button>
      <button type="button" className="settings-save" disabled={!preview || loading || installing} onClick={() => void install()}>
        {installing ? <LoaderCircle className="spin" /> : <Download />}
        {installing ? '正在安装…' : preview?.canUpdate ? '更新技能' : '安装技能'}
      </button>
    </footer>
  </DetailDialog>;
}
