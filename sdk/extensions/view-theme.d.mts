export interface PiStudioViewTheme {
  readonly theme: 'light' | 'dark';
  readonly tokens: Readonly<Partial<Record<`--${string}`, string>>>;
}

/** Sent when a sandboxed view is ready and whenever its host context changes. */
export interface PiStudioViewHostContext extends PiStudioViewTheme {
  readonly protocol: 'pi-studio:ext-view:v1';
  readonly type: 'host:context';
  readonly scope: 'global' | 'session';
  readonly cwd: string;
  readonly sessionId: string;
  readonly workspaces: ReadonlyArray<{ name: string; path: string }>;
  readonly invocable: boolean;
}

export const studioViewTokens: readonly `--${string}`[];
export function applyStudioTheme(context: PiStudioViewTheme, root?: HTMLElement): 'light' | 'dark';
