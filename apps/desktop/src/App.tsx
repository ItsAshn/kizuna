import { Routes, Route, Navigate } from 'react-router-dom'
import { useEffect, useState } from 'react'

declare const __VERCEL__: boolean
import { useServerStore } from './store/serverStore'
import { useUpdater } from './hooks/useUpdater'
import { useBackgroundNotifications } from './hooks/useBackgroundNotifications'
import Welcome from './routes/Welcome'
import Chat from './routes/Chat'
import Login from './routes/Login'
import ServerPanel from './components/ServerPanel'
import UpdateBanner from './components/UpdateBanner'
import SetupWizard from './components/SetupWizard'
import './styles/global.css'
import './styles/app.css'

const WIZARD_KEY = 'kizuna-setup-wizard-dismissed'

function AppContent() {
  const activeSession = useServerStore((s) => s.activeSession)
  const [showWizard, setShowWizard] = useState(false)

  useEffect(() => {
    const dismissed = localStorage.getItem(WIZARD_KEY)
    if (!dismissed && !!(window as any).__TAURI_INTERNALS__) {
      setShowWizard(true)
    }
  }, [])

  return (
    <div className="app-shell__content" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Routes>
        <Route path="/" element={activeSession ? <Navigate to="/chat" replace /> : <Welcome isLanding={__VERCEL__} />} />
        <Route path="/login/:serverId" element={<Login />} />
        <Route path="/chat" element={activeSession ? <Chat /> : <Navigate to="/" replace />} />
      </Routes>
      {showWizard && <SetupWizard onClose={() => setShowWizard(false)} />}
    </div>
  )
}

export default function App() {
  useUpdater()
  useBackgroundNotifications()

  return (
    <div className="app-shell">
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <UpdateBanner />
        <AppContent />
      </div>
    </div>
  )
}
