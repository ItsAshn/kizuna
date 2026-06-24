import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, SavedServer } from '@kizuna/shared'
import { getMe, setClientToken, clearClientToken, refreshToken, setTokenRefreshHandler } from '@kizuna/shared'

interface ServerSession {
  serverId: string
  url: string
  token: string
  user: User
}

interface ServerState {
  servers: SavedServer[]
  sessions: Record<string, ServerSession>
  activeServerId: string | null
  activeSession: ServerSession | null
  addServer: (server: SavedServer) => void
  removeServer: (id: string) => void
  setActiveSession: (session: ServerSession | null) => void
  setActiveServer: (serverId: string | null) => void
  updateServerInfo: (id: string, updates: Partial<SavedServer>) => void
  reorderServers: (fromId: string, toId: string, position: 'above' | 'below') => void
  refreshSessionUser: () => Promise<void>
}

export const useServerStore = create<ServerState>()(
  persist(
    (set, get) => ({
      servers: [],
      sessions: {},
      activeServerId: null,
      activeSession: null,

      addServer: (server) =>
        set((state) => ({
          servers: [...state.servers.filter((s) => s.url !== server.url), server],
        })),

      removeServer: (id) =>
        set((state) => {
          const { [id]: removedSession, ...restSessions } = state.sessions
          if (removedSession) {
            clearClientToken(removedSession.url)
          }
          return {
            servers: state.servers.filter((s) => s.id !== id),
            sessions: restSessions,
            activeServerId: state.activeServerId === id ? null : state.activeServerId,
            activeSession: state.activeServerId === id ? null : state.activeSession,
          }
        }),

      setActiveSession: (session) =>
        set((state) => {
          if (!session) {
            if (state.activeSession) {
              clearClientToken(state.activeSession.url)
            }
            return { activeSession: null, activeServerId: null }
          }
          setClientToken(session.url, session.token)
          return {
            activeSession: session,
            activeServerId: session.serverId,
            sessions: { ...state.sessions, [session.serverId]: session },
          }
        }),

      setActiveServer: (serverId) =>
        set((state) => {
          if (!serverId) return { activeSession: null, activeServerId: null }
          const session = state.sessions[serverId]
          return {
            activeServerId: serverId,
            activeSession: session || null,
          }
        }),

      updateServerInfo: (id, updates) =>
        set((state) => ({
          servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
        })),

      reorderServers: (fromId, toId, position) =>
        set((state) => {
          const fromIdx = state.servers.findIndex((s) => s.id === fromId)
          const toIdx = state.servers.findIndex((s) => s.id === toId)
          if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return state
          const fromServer = state.servers[fromIdx]
          const toServer = state.servers[toIdx]

          function reorder(servers: SavedServer[]): SavedServer[] {
            const newFromIdx = servers.findIndex((s) => s.id === fromId)
            const moved = servers[newFromIdx]
            const reordered = [...servers]
            reordered.splice(newFromIdx, 1)
            let insertAt = reordered.findIndex((s) => s.id === toId)
            if (position === 'below') insertAt++
            if (insertAt < 0) insertAt = reordered.length
            reordered.splice(insertAt, 0, moved)
            return reordered
          }

          if (!fromServer.folder && !toServer.folder) {
            const base = 'New Folder'
            let name = base
            let n = 2
            while (state.servers.some((s) => s.folder === name)) {
              name = `${base} (${n})`
              n++
            }
            const folderName = name
            const updated = state.servers.map((s) => {
              if (s.id === fromId || s.id === toId) return { ...s, folder: folderName }
              return s
            })
            return { servers: reorder(updated) }
          }

          if (fromServer.folder !== toServer.folder) {
            const targetFolder = toServer.folder
            const updated = state.servers.map((s) => {
              if (s.id === fromId) return { ...s, folder: targetFolder }
              return s
            })
            return { servers: reorder(updated) }
          }

          return { servers: reorder(state.servers) }
        }),

      refreshSessionUser: async () => {
        const { activeSession } = get()
        if (!activeSession) return
        try {
          const user = await getMe(activeSession.url)
          set((state) => {
            const session = { ...activeSession, user }
            return {
              activeSession: session,
              sessions: { ...state.sessions, [session.serverId]: session },
            }
          })
        } catch {
          // token may be expired — auth middleware handles this elsewhere
        }
      },
    }),
    {
      name: 'kizuna-servers',
      partialize: (state) => ({
        servers: state.servers,
        sessions: state.sessions,
        activeServerId: state.activeServerId,
        activeSession: state.activeSession,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (state?.activeSession) {
            setClientToken(state.activeSession.url, state.activeSession.token)
          }
        }
      },
    },
  ),
)

setTokenRefreshHandler(async (serverUrl: string) => {
  try {
    const newToken = await refreshToken(serverUrl)
    if (!newToken) return null
    const session = useServerStore.getState().activeSession
    if (session && session.url === serverUrl) {
      useServerStore.getState().setActiveSession({ ...session, token: newToken })
    }
    return newToken
  } catch {
    return null
  }
})
