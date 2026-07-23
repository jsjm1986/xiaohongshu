import { Component, type ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
}

/** 页面级渲染兜底：单个页面抛错时给出可恢复界面，而不是白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[ui] 页面渲染异常', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <CircleAlert size={28} />
          <h2>页面出现异常</h2>
          <p>当前页面渲染时发生错误，刷新即可重试；其他页面不受影响。</p>
          <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}
