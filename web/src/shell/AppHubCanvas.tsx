import { lazy, memo, Suspense, useEffect, useMemo, useState } from 'react';
import { ShellHeader } from './ShellLayout';
import { LoadingState } from '../shared/LoadingState';
import type { ExtensionUiItem } from '../types/extension-types';
import type { SettingsSnapshot, StudioPluginSummary } from '../types/global';
import type { OpenPluginResource } from '../features/plugins/PluginDetails';

let pluginSettingsPromise: Promise<typeof import('../features/plugins/PluginSettings')> | null = null;

export function preloadAppHub() {
  pluginSettingsPromise ??= import('../features/plugins/PluginSettings').catch((error) => {
    pluginSettingsPromise = null;
    throw error;
  });
  return pluginSettingsPromise;
}

const PluginSettings = lazy(async () => {
  const module = await preloadAppHub();
  return { default: module.PluginSettings };
});

let cachedPlugins: readonly StudioPluginSummary[] | undefined;

type AppHubCanvasProps = {
  cwd: string;
  initialPlugins?: readonly StudioPluginSummary[];
  panels: readonly ExtensionUiItem[];
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onOpenApp: (panelId: string) => void;
  onOpenResource?: OpenPluginResource;
  onPluginsChanged?: (settings: SettingsSnapshot, message: string) => void;
};

/**
 * First-class Apps & Plugins hub rendered directly in the main workspace canvas
 * (rather than bouncing into the Settings overlay). Shows all installed and
 * available packages across every configured plugin source.
 */
function AppHubCanvasComponent({
  cwd,
  initialPlugins,
  panels,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenApp,
  onOpenResource,
  onPluginsChanged,
}: AppHubCanvasProps) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [plugins, setPlugins] = useState<readonly StudioPluginSummary[]>(() => initialPlugins ?? cachedPlugins ?? []);
  const [loading, setLoading] = useState(!initialPlugins && !cachedPlugins);

  useEffect(() => {
    if (initialPlugins) {
      cachedPlugins = initialPlugins;
      setPlugins(initialPlugins);
      setLoading(false);
    }
  }, [initialPlugins]);

  useEffect(() => {
    let active = true;
    void window.piApi.settings(cwd).then((snapshot) => {
      const next = snapshot.plugins || [];
      cachedPlugins = next;
      if (active) setPlugins(next);
    }).catch(() => {}).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [cwd]);

  const openablePanels = useMemo(() => {
    const map = new Map<string, string>();
    for (const panel of panels) {
      if (panel.slot !== 'tool.view') continue;
      const bareId = panel.extensionId.replace(/^(?:user|project|builtin):/, '');
      if (!map.has(bareId)) map.set(bareId, panel.id);
    }
    return map;
  }, [panels]);

  return (
    <>
      <ShellHeader
        className="chat-header main-app-header"
        onExpandSidebar={sidebarCollapsed ? onExpandSidebar : undefined}
      >
        <div className="main-app-heading">
          {sidebarCollapsed && <span className="main-app-title">应用</span>}
        </div>
      </ShellHeader>
      <main className="main shell-canvas app-hub-canvas" aria-label="应用与插件">
        <div className="app-hub-scroll settings-content">
          <div className="app-hub-frame">
            <header className="app-hub-header">
              <div className="app-hub-heading">
                <h1>应用</h1>
                <p>浏览所有插件源中的应用与能力包；点击卡片查看详情与工具说明，已安装应用可直接打开。</p>
              </div>
              <div className="app-hub-toolbar plugin-workspace-actions" ref={setToolbar} />
            </header>
            <Suspense fallback={<LoadingState variant="section">正在加载应用目录…</LoadingState>}>
              <PluginSettings
                toolbar={toolbar}
                plugins={plugins}
                busy={loading}
                cwd={cwd}
                showStatusFilter
                openablePanels={openablePanels}
                onOpenApp={onOpenApp}
                onOpenResource={onOpenResource}
                onChanged={(settings, message) => {
                  const next = settings.plugins || [];
                  cachedPlugins = next;
                  setPlugins(next);
                  onPluginsChanged?.(settings, message);
                }}
              />
            </Suspense>
          </div>
        </div>
      </main>
    </>
  );
}

export const AppHubCanvas = memo(AppHubCanvasComponent);
