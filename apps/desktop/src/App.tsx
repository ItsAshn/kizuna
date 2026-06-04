import { Routes, Route, Navigate } from 'react-router-dom'
import { useServerStore } from './store/serverStore'
import { useUpdater } from './hooks/useUpdater'
import { useBackgroundNotifications } from './hooks/useBackgroundNotifications'
import Welcome from './routes/Welcome'
import Chat from './routes/Chat'
import Login from './routes/Login'
import ServerPanel from './components/ServerPanel'
import UpdateBanner from './components/UpdateBanner'
import './styles/global.css'
import './styles/app.css'

function AppContent() {
  const activeSession = useServerStore((s) => s.activeSession)

  return (
    <div className="app-shell__content" style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <Routes>
        <Route path="/" element={activeSession ? <Navigate to="/chat" replace /> : <Welcome isLanding={true} />} />
        <Route path="/login/:serverId" element={<Login />} />
        <Route path="/chat" element={activeSession ? <Chat /> : <Navigate to="/" replace />} />
      </Routes>
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
