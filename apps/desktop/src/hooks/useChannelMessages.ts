import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { Socket } from 'socket.io-client'
import {
  fetchMessages,
  fetchDMMessages,
  fetchGroupDMMessages,
  fetchChannelPermissions,
  fetchPinnedMessages,
} from '@kizuna/shared'
import type { Message, PinnedMessage } from '@kizuna/shared'
import { useChatStore } from '../store/chatStore'
import { useSettingsStore } from '../store/settingsStore'
import type { ServerSession } from '../store/serverStore'

interface UseChannelMessagesOptions {
  session: ServerSession | null
  socketRef: MutableRefObject<Socket | null>
  tryDecryptDM: (msg: Message) => Message
  tryDecryptGroupDM: (msg: Message) => Message
}

const PAGE_SIZE = 50

/** Whether another older page may exist after fetching one. A full page means
 * the server probably has more (it also reports hasMore itself on some routes).
 * A page that added nothing new means we are looping on the same cursor, so stop. */
export function olderPageHasMore(
  pageLength: number,
  limit: number,
  serverHasMore: boolean,
  added: number,
): boolean {
  if (added <= 0) return false
  return serverHasMore || pageLength >= limit
}

// Loads message history (plus permissions/pins/read-state) whenever the active
// channel, DM, or group DM changes, and exposes upward pagination.
export function useChannelMessages({
  session,
  socketRef,
  tryDecryptDM,
  tryDecryptGroupDM,
}: UseChannelMessagesOptions) {
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId)
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId)
  const dmChannels = useChatStore((s) => s.dmChannels)
  const groupDMChannels = useChatStore((s) => s.groupDMChannels)
  const setPinned = useChatStore((s) => s.setPinnedMessages)
  // Bumped by useSocket on every reconnect: the new socket is in no rooms and
  // missed whatever was sent while it was down, so each effect below rejoins
  // its room and refetches the newest page (merged into the cache by id).
  const reconnectNonce = useSettingsStore((s) => s.socketReconnectNonce)
  const activeAnyChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId || null

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [channelPerms, setChannelPerms] = useState<{
    can_write: boolean
    locked: boolean
  } | null>(null)
  const newMessagesRef = useRef<string | null>(null)
  // Which channel the current channelPerms belong to, so re-entering the same
  // channel can keep them instead of flashing the composer's locked state.
  const permsChannelRef = useRef<string | null>(null)

  /* Skeletons are for a cold channel only. chatStore.messages is a per-channel
   * cache that survives navigation, so re-entry renders instantly and the
   * fetch below revalidates behind it. */
  const beginLoad = useCallback((channelId: string) => {
    const cached = useChatStore.getState().messages[channelId]
    setLoading(!cached || cached.length === 0)
    setLoadError(null)
  }, [])

  const reloadMessages = useCallback(() => setReloadNonce((n) => n + 1), [])

  /* Locate the "New Messages" separator against the last-read time we had
   * *before* this visit, then tell the server the conversation is read. The
   * read ack returns "now", so emitting it before the fetch resolved used to
   * overwrite lastRead first and the separator never showed. */
  const markReadAfterFetch = useCallback(
    (
      readEvent: 'channel:read' | 'dm:read' | 'group-dm:read',
      channelId: string,
      msgs: Message[] | null,
      isCancelled: () => boolean,
    ) => {
      if (isCancelled()) return
      if (msgs) {
        const lastRead = useChatStore.getState().channelLastReadAt[channelId]
        const firstNew = lastRead ? msgs.find((m) => m.created_at > lastRead) : undefined
        newMessagesRef.current = firstNew ? firstNew.id : null
      }
      socketRef.current?.emit(readEvent, { channelId }, (res: { last_read_at?: number }) => {
        if (isCancelled()) return
        if (res?.last_read_at) {
          useChatStore.getState().setChannelLastReadAt(channelId, res.last_read_at)
        }
      })
    },
    [socketRef],
  )

  useEffect(() => {
    if (activeChannelId) {
      let cancelled = false
      beginLoad(activeChannelId)
      if (permsChannelRef.current !== activeChannelId) setChannelPerms(null)
      permsChannelRef.current = activeChannelId
      fetchMessages(session!.url, activeChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return
          useChatStore.getState().reconcileMessages(activeChannelId, msgs)
          useChatStore.getState().setHasMoreMessages(activeChannelId, hasMore)
          markReadAfterFetch('channel:read', activeChannelId, msgs, () => cancelled)
        })
        .catch((err) => {
          console.error('Failed to load messages:', err)
          if (!cancelled) setLoadError('Failed to load messages')
          markReadAfterFetch('channel:read', activeChannelId, null, () => cancelled)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      fetchChannelPermissions(session!.url, activeChannelId)
        .then((perms) => {
          if (!cancelled) setChannelPerms(perms)
        })
        .catch((err) => {
          console.error('Failed to fetch channel permissions:', err)
          if (!cancelled) setChannelPerms(null)
        })

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeChannelId]: 0 },
      }))

      fetchPinnedMessages(session!.url, activeChannelId)
        .then((pins: Message[]) => {
          if (cancelled) return
          setPinned(activeChannelId, pins as unknown as PinnedMessage[])
        })
        .catch((err) => {
          console.error('Failed to load pins:', err)
        })

      socketRef.current?.emit('channel:join', activeChannelId)
      socketRef.current?.emit('mentions:read', { channelId: activeChannelId })

      return () => {
        cancelled = true
        socketRef.current?.emit('channel:leave', activeChannelId)
        socketRef.current?.emit('typing:stop', { channelId: activeChannelId })
      }
    }
  }, [activeChannelId, reloadNonce, reconnectNonce])

  useEffect(() => {
    if (activeDMChannelId) {
      let cancelled = false
      beginLoad(activeDMChannelId)
      setChannelPerms(null)
      permsChannelRef.current = null
      fetchDMMessages(session!.url, activeDMChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return
          const decrypted = msgs.map((m) => tryDecryptDM(m))
          useChatStore.getState().reconcileMessages(activeDMChannelId, decrypted)
          useChatStore.getState().setHasMoreMessages(activeDMChannelId, hasMore)
          markReadAfterFetch('dm:read', activeDMChannelId, decrypted, () => cancelled)
        })
        .catch((err) => {
          console.error('Failed to load messages:', err)
          if (!cancelled) setLoadError('Failed to load messages')
          markReadAfterFetch('dm:read', activeDMChannelId, null, () => cancelled)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeDMChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeDMChannelId]: 0 },
      }))

      socketRef.current?.emit('channel:join', activeDMChannelId)

      return () => {
        cancelled = true
        socketRef.current?.emit('channel:leave', activeDMChannelId)
        socketRef.current?.emit('typing:stop', { channelId: activeDMChannelId })
      }
    }
  }, [activeDMChannelId, tryDecryptDM, reloadNonce, reconnectNonce])

  // Re-decrypt already-loaded DM messages when channel keys arrive/change.
  useEffect(() => {
    if (!activeDMChannelId) return
    const store = useChatStore.getState()
    const msgs = store.messages[activeDMChannelId]
    if (!msgs || msgs.length === 0) return
    const decrypted = msgs.map((m) => tryDecryptDM(m))
    const needsUpdate = decrypted.some((d, i) => d.content !== msgs[i].content)
    if (needsUpdate) {
      store.setMessages(activeDMChannelId, decrypted)
    }
  }, [dmChannels, tryDecryptDM, activeDMChannelId])

  useEffect(() => {
    if (activeGroupDMChannelId) {
      let cancelled = false
      beginLoad(activeGroupDMChannelId)
      setChannelPerms(null)
      permsChannelRef.current = null
      fetchGroupDMMessages(session!.url, activeGroupDMChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return
          const decrypted = msgs.map((m) => tryDecryptGroupDM(m))
          useChatStore.getState().reconcileMessages(activeGroupDMChannelId, decrypted)
          useChatStore.getState().setHasMoreMessages(activeGroupDMChannelId, hasMore)
          markReadAfterFetch('group-dm:read', activeGroupDMChannelId, decrypted, () => cancelled)
        })
        .catch((err) => {
          console.error('Failed to load messages:', err)
          if (!cancelled) setLoadError('Failed to load messages')
          markReadAfterFetch('group-dm:read', activeGroupDMChannelId, null, () => cancelled)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeGroupDMChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeGroupDMChannelId]: 0 },
      }))

      socketRef.current?.emit('channel:join', activeGroupDMChannelId)

      return () => {
        cancelled = true
        socketRef.current?.emit('channel:leave', activeGroupDMChannelId)
        socketRef.current?.emit('typing:stop', { channelId: activeGroupDMChannelId })
      }
    }
  }, [activeGroupDMChannelId, tryDecryptGroupDM, reloadNonce, reconnectNonce])

  // Re-decrypt already-loaded group-DM messages when member keys arrive/change.
  useEffect(() => {
    if (!activeGroupDMChannelId) return
    const store = useChatStore.getState()
    const msgs = store.messages[activeGroupDMChannelId]
    if (!msgs || msgs.length === 0) return
    const decrypted = msgs.map((m) => tryDecryptGroupDM(m))
    const needsUpdate = decrypted.some((d, i) => d.content !== msgs[i].content)
    if (needsUpdate) {
      store.setMessages(activeGroupDMChannelId, decrypted)
    }
  }, [groupDMChannels, tryDecryptGroupDM, activeGroupDMChannelId])

  const loadMoreMessages = useCallback(() => {
    const channelId = activeAnyChannelId
    if (!channelId || !session) return
    const store = useChatStore.getState()
    const channelMessages = store.messages[channelId] || []
    if (!store.hasMoreMessages[channelId] || channelMessages.length === 0) return
    if (store.loadingMoreMessages[channelId]) return
    const oldestId = channelMessages[0].id
    if (!oldestId) return
    store.setLoadingMoreMessages(channelId, true)
    store.setLoadMoreError(channelId, null)
    ;(async () => {
      try {
        const { messages: olderMsgs, hasMore } =
          channelId === activeDMChannelId
            ? await fetchDMMessages(session.url, channelId, PAGE_SIZE, oldestId)
            : channelId === activeGroupDMChannelId
              ? await fetchGroupDMMessages(session.url, channelId, PAGE_SIZE, oldestId)
              : await fetchMessages(session.url, channelId, PAGE_SIZE, oldestId)
        if (olderMsgs.length === 0) {
          store.setHasMoreMessages(channelId, false)
          return
        }
        // Read lengths through getState(): `store` is the snapshot from before
        // the await, and its `messages` never reflects the prepend below.
        const beforeLen = (useChatStore.getState().messages[channelId] || []).length
        const decrypted =
          channelId === activeDMChannelId
            ? olderMsgs.map((m) => tryDecryptDM(m))
            : channelId === activeGroupDMChannelId
              ? olderMsgs.map((m) => tryDecryptGroupDM(m))
              : olderMsgs
        store.prependMessages(channelId, decrypted)
        const afterLen = (useChatStore.getState().messages[channelId] || []).length
        store.setHasMoreMessages(
          channelId,
          olderPageHasMore(olderMsgs.length, PAGE_SIZE, hasMore, afterLen - beforeLen),
        )
      } catch (err) {
        console.error('Failed to load more messages:', err)
        store.setLoadMoreError(channelId, 'Failed to load older messages')
        store.setHasMoreMessages(channelId, true)
      } finally {
        store.setLoadingMoreMessages(channelId, false)
      }
    })()
  }, [
    activeChannelId,
    activeDMChannelId,
    activeGroupDMChannelId,
    session,
    tryDecryptDM,
    tryDecryptGroupDM,
  ])

  const retryLoadMoreMessages = useCallback(() => {
    const channelId = activeAnyChannelId
    if (!channelId) return
    const store = useChatStore.getState()
    store.setHasMoreMessages(channelId, true)
    store.setLoadMoreError(channelId, null)
    loadMoreMessages()
  }, [activeChannelId, activeDMChannelId, activeGroupDMChannelId, loadMoreMessages])

  return {
    loading,
    loadError,
    channelPerms,
    newMessagesRef,
    loadMoreMessages,
    retryLoadMoreMessages,
    reloadMessages,
  }
}
