import { Component, type ErrorInfo, type ReactNode } from 'react'

interface DiffErrorBoundaryProps {
  children: ReactNode
  onExitDiff: () => void
  onResetBase?: () => void
  resetKey: string
}

interface DiffErrorBoundaryState {
  hasError: boolean
}

export class DiffErrorBoundary extends Component<DiffErrorBoundaryProps, DiffErrorBoundaryState> {
  state: DiffErrorBoundaryState = {
    hasError: false,
  }

  static getDerivedStateFromError(): DiffErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Diff] render crashed:', error, info)
  }

  componentDidUpdate(prevProps: DiffErrorBoundaryProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-gm-surface px-6 text-center">
        <div className="space-y-1">
          <div className="text-body font-bold text-gm-text">Diff 视图加载失败</div>
          <div className="text-caption text-gm-text-tertiary">
            已自动拦截本次渲染异常，避免编辑器白屏。
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.props.onExitDiff}
            className="rounded-full bg-gm-primary px-3 py-1.5 text-caption font-bold text-gm-text-on-primary transition-opacity hover:opacity-90"
          >
            返回编辑模式
          </button>
          {this.props.onResetBase ? (
            <button
              type="button"
              onClick={this.props.onResetBase}
              className="rounded-full border border-gm-border px-3 py-1.5 text-caption text-gm-text-secondary transition-colors hover:border-gm-primary/40 hover:text-gm-primary"
            >
              重置 Diff 基准
            </button>
          ) : null}
        </div>
      </div>
    )
  }
}
