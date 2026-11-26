import { Component, Suspense, lazy, type ReactNode } from 'react';
import { LoadingState } from './LoadingState';
import type { FilePreviewProps } from './FilePreview';

let filePreviewPromise: Promise<typeof import('./FilePreview')> | null = null;

export function preloadFilePreview() {
  filePreviewPromise ??= import('./FilePreview').catch((error) => {
    filePreviewPromise = null;
    throw error;
  });
  return filePreviewPromise;
}

const LazyFilePreview = lazy(async () => {
  const module = await preloadFilePreview();
  return { default: module.FilePreview };
});

class FilePreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="file-preview-load-failure" role="alert">
        文件预览暂时无法加载
      </div>;
    }
    return this.props.children;
  }
}

/**
 * Defer the preview implementation and its stylesheet until a file is opened.
 * Failures stay inside the selected file surface and never unmount App state.
 */
export function DeferredFilePreview(props: FilePreviewProps) {
  return <FilePreviewBoundary>
    <Suspense fallback={
      <LoadingState variant="panel">正在加载文件预览…</LoadingState>
    }>
      <LazyFilePreview {...props} />
    </Suspense>
  </FilePreviewBoundary>;
}
