import { Component, Suspense, lazy, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { FilePreviewProps } from './FilePreview';

const LazyFilePreview = lazy(async () => {
  const module = await import('./FilePreview');
  return { default: module.FilePreview };
});

class FilePreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="panel-route-loading file-preview-load-failure" role="alert">
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
      <div className="panel-route-loading" role="status" aria-label="正在加载文件预览">
        <LoaderCircle aria-hidden="true" />
      </div>
    }>
      <LazyFilePreview {...props} />
    </Suspense>
  </FilePreviewBoundary>;
}
