import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState, lazy, Suspense } from 'react'

declare const __VERCEL__: boolean
import { useServerStore } from './store/serverStore'
import { useUpdater } from './hooks/useUpdater'
import { useBackgroundNotifications } from './hooks/useBackgroundNotifications'
import ErrorBoundary from './components/ErrorBoundary'
import SetupWizard from './components/SetupWizard'
import UserSettingsModal from './components/UserSettingsModal'
import './styles/global.css'
import './styles/app.css'
import './styles/mobile.css'

const Welcome = lazy(() => import('./routes/Welcome'))
const Chat = lazy(() => import('./routes/Chat'))
const Login = lazy(() => import('./routes/Login'))
const ResetPassword = lazy(() => import('./routes/ResetPassword'))
const RouteFallback = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
    Loading...
  </div>
)

const WIZARD_KEY = 'kizuna-setup-wizard-dismissed'

function AppContent() {
  const activeSession = useServerStore((s) => s.activeSession)
  const [showWizard, setShowWizard] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    const dismissed = localStorage.getItem(WIZARD_KEY)
    if (!dismissed && !!(window as any).__TAURI_INTERNALS__) {
      setShowWizard(true)
    }
  }, [])

  const handleOpenSettings = () => setShowSettings(true)

  return (
    <div className="app-shell__content" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={activeSession ? <Navigate to="/chat" replace /> : <Welcome isLanding={__VERCEL__} onOpenSettings={handleOpenSettings} />} />
          <Route path="/login/:serverId" element={<Login />} />
          <Route path="/reset-password/:serverId" element={<ResetPassword />} />
          <Route path="/chat" element={activeSession ? <Chat onOpenSettings={handleOpenSettings} /> : <Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {showWizard && <SetupWizard onClose={() => setShowWizard(false)} />}
      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}

export default function App() {
  const activeSession = useServerStore((s) => s.activeSession)
  useUpdater()
  useBackgroundNotifications()

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <AppContent />
      </div>
    </ErrorBoundary>
  )
}
