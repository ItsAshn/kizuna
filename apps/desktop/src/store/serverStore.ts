import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, SavedServer } from '@kizuna/shared'
import { getMe, setClientToken, clearClientToken, refreshToken, setTokenRefreshHandler, logout, normalizeUrl } from '@kizuna/shared'

export interface ServerSession {
  serverId: string
  url: string
  token: string
  user: User
}

/* Three different things can happen to a server, and they are deliberately
 * separate actions:
 *
 *   setActiveServer(null) — stop *viewing* a server. The session survives, so
 *     coming back is a back button, not a login screen.
 *   logoutServer(id)      — end the session for real (server-side too) but keep
 *     the server saved. This is the "disconnect" offered from the main menu.
 *   removeServer(id)      — log out and forget the server entirely.
 *
 * clearSession is the local half of a logout, for sessions the server has
 * already ended for us (kick, ban, expired refresh) where calling /logout would
 * only 401.
 */
interface ServerState {
  servers: SavedServer[]
  sessions: Record<string, ServerSession>
  activeServerId: string | null
  activeSession: ServerSession | null
  addServer: (server: SavedServer) => void
  removeServer: (id: string) => void
  setActiveSession: (session: ServerSession) => void
  setActiveServer: (serverId: string | null) => void
  clearSession: (serverId: string) => void
  logoutServer: (serverId: string) => Promise<void>
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

      removeServer: (id) => {
        // Forgetting a server implies logging out of it: leaving the session
        // alive server-side would let the refresh cookie sign us back in the
        // moment the server is re-added.
        void get().logoutServer(id)
        set((state) => ({ servers: state.servers.filter((s) => s.id !== id) }))
      },

      setActiveSession: (session) =>
        set((state) => {
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
          // The token store is module state, not persisted with the session, so
          // re-entering a server has to re-arm it. Skipping this is what made
          // every request 401 and sent the user back to the login screen.
          if (session) setClientToken(session.url, session.token)
          return {
            activeServerId: serverId,
            activeSession: session || null,
          }
        }),

      clearSession: (serverId) =>
        set((state) => {
          const session = state.sessions[serverId]
          if (session) clearClientToken(session.url)
          const { [serverId]: _removed, ...restSessions } = state.sessions
          const wasActive = state.activeServerId === serverId
          return {
            sessions: restSessions,
            activeServerId: wasActive ? null : state.activeServerId,
            activeSession: wasActive ? null : state.activeSession,
          }
        }),

      logoutServer: async (serverId) => {
        const session = get().sessions[serverId]
        // Drop the local session first: the user asked to be logged out, and
        // that has to hold whether or not the server is reachable.
        get().clearSession(serverId)
        if (!session) return
        try {
          await logout(session.url, session.token)
        } catch {
          // Offline, or the token was already dead. Either way the session is
          // gone locally; a stale cookie can only revive it on this server.
        }
      },

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
          if (!user) return
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
      merge: (persisted, current) => {
        const merged = { ...current, ...(persisted as Partial<ServerState>) }
        // A persisted session with no user is corrupt: consumers guard `session`
        // being null but assume `session.user` exists, so a userless session
        // crashes the whole tree. Treat it as no active session instead.
        if (merged.activeSession && !merged.activeSession.user) {
          merged.activeSession = null
        }
        return merged
      },
      onRehydrateStorage: () => {
        return (state) => {
          // Every saved session, not just the active one: the home dashboard
          // and the background notification sockets talk to servers the user
          // isn't currently viewing.
          for (const session of Object.values(state?.sessions ?? {})) {
            setClientToken(session.url, session.token)
          }
          if (state?.activeSession) {
            setClientToken(state.activeSession.url, state.activeSession.token)
          }
        }
      },
    },
  ),
)

setTokenRefreshHandler(async (serverUrl: string) => {
  const sessions = useServerStore.getState().sessions
  const session = Object.values(sessions).find((s) => normalizeUrl(s.url) === normalizeUrl(serverUrl))
  // No local session means the user logged out of this server (or never logged
  // in). The refresh cookie may still be valid — a logout that couldn't reach
  // the server never cleared it — and honouring it here would silently sign
  // them back in behind a UI that says they're signed out.
  if (!session) return null

  try {
    const newToken = await refreshToken(serverUrl)
    if (!newToken) return null
    const store = useServerStore.getState()
    if (store.activeSession && normalizeUrl(store.activeSession.url) === normalizeUrl(serverUrl)) {
      store.setActiveSession({ ...store.activeSession, token: newToken })
    } else {
      // Background server: keep its stored token in step so the next launch
      // rehydrates something that still works.
      useServerStore.setState((state) => ({
        sessions: { ...state.sessions, [session.serverId]: { ...session, token: newToken } },
      }))
      setClientToken(session.url, newToken)
    }
    return newToken
  } catch {
    return null
  }
})
