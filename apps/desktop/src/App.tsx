import { Routes, Route, Navigate } from 'react-router-dom'
import { useServerStore } from './store/serverStore'
import Welcome from './routes/Welcome'
import Chat from './routes/Chat'
import Login from './routes/Login'
import './styles/global.css'
import './styles/app.css'

export default function App() {
  const activeSession = useServerStore((s) => s.activeSession)

  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={activeSession ? <Navigate to="/chat" replace /> : <Welcome />} />
        <Route path="/login/:serverId" element={<Login />} />
        <Route path="/chat" element={activeSession ? <Chat /> : <Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
