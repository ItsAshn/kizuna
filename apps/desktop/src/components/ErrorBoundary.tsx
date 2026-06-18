import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo)
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100dvh',
          width: '100vw',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          padding: '40px',
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: '48px',
            fontWeight: 700,
            color: 'var(--red)',
            marginBottom: '16px',
          }}>
            Something went wrong
          </div>
          <p style={{
            color: 'var(--text-secondary)',
            fontSize: '15px',
            maxWidth: '480px',
            marginBottom: '8px',
            lineHeight: 1.6,
          }}>
            An unexpected error occurred in the Kizuna client.
          </p>
          {this.state.error && (
            <pre style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              padding: '12px 16px',
              marginBottom: '24px',
              fontSize: '12px',
              color: 'var(--red)',
              maxWidth: '600px',
              overflow: 'auto',
              textAlign: 'left',
              fontFamily: 'var(--font-mono)',
            }}>
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          )}
          <button
            onClick={this.handleReload}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'var(--brand)',
              color: 'var(--text-primary)',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              padding: '10px 24px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={16} />
            Reload Kizuna
          </button>
          <p style={{
            color: 'var(--text-muted)',
            fontSize: '12px',
            marginTop: '16px',
          }}>
            If the problem persists, try clearing your browser data or reinstalling the app.
          </p>
        </div>
      )
    }

    return this.props.children
  }
}
