import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * App-wide safety net. Without this, any uncaught render-phase throw unmounts
 * the whole React tree and leaves a blank page with no way back — worse here
 * than in most apps, since the tunnel keeps running and the operator is left
 * with no way to see or change anything.
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Erreur non rattrapee :', error, info)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="grid min-h-screen place-items-center bg-surface px-6 text-on-surface">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-normal">Quelque chose s’est mal passé</h1>
          <p className="text-sm text-on-surface-variant">
            L’interface a rencontré une erreur inattendue. Le tunnel, lui, continue de fonctionner :
            recharger suffit généralement.
          </p>
          <p className="font-mono text-xs break-words text-error">{this.state.error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="state-layer inline-flex h-10 items-center rounded-[var(--radius-md3-full)] bg-primary px-6 text-sm font-medium text-on-primary"
          >
            Recharger
          </button>
        </div>
      </div>
    )
  }
}
