import { useState, useEffect, useRef, useCallback } from 'react';
import type { MutableRefObject } from 'react';
import type { Socket } from 'socket.io-client';
import {
  fetchMessages,
  fetchDMMessages,
  fetchGroupDMMessages,
  fetchChannelPermissions,
  fetchPinnedMessages,
} from '@kizuna/shared';
import type { Message, PinnedMessage } from '@kizuna/shared';
import { useChatStore } from '../store/chatStore';
import type { ServerSession } from '../store/serverStore';

interface UseChannelMessagesOptions {
  session: ServerSession | null;
  socketRef: MutableRefObject<Socket | null>;
  tryDecryptDM: (msg: Message) => Message;
  tryDecryptGroupDM: (msg: Message) => Message;
}

// Loads message history (plus permissions/pins/read-state) whenever the active
// channel, DM, or group DM changes, and exposes upward pagination.
export function useChannelMessages({
  session,
  socketRef,
  tryDecryptDM,
  tryDecryptGroupDM,
}: UseChannelMessagesOptions) {
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId);
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId);
  const dmChannels = useChatStore((s) => s.dmChannels);
  const groupDMChannels = useChatStore((s) => s.groupDMChannels);
  const setPinned = useChatStore((s) => s.setPinnedMessages);
  const activeAnyChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId || null;

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [channelPerms, setChannelPerms] = useState<{
    can_write: boolean;
    locked: boolean;
  } | null>(null);
  const newMessagesRef = useRef<string | null>(null);

  const reloadMessages = useCallback(() => setReloadNonce((n) => n + 1), []);

  useEffect(() => {
    if (activeChannelId) {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      setChannelPerms(null);
      fetchMessages(session!.url, activeChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return;
          useChatStore.getState().setMessages(activeChannelId, msgs);
          useChatStore.getState().setHasMoreMessages(activeChannelId, hasMore);
          const lastRead = useChatStore.getState().channelLastReadAt[activeChannelId];
          if (lastRead && msgs.length > 0) {
            const firstNew = msgs.find((m) => m.created_at > lastRead);
            newMessagesRef.current = firstNew ? firstNew.id : null;
          } else {
            newMessagesRef.current = null;
          }
        })
        .catch((err) => {
          console.error('Failed to load messages:', err);
          if (!cancelled) setLoadError('Failed to load messages');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      fetchChannelPermissions(session!.url, activeChannelId)
        .then((perms) => {
          if (!cancelled) setChannelPerms(perms);
        })
        .catch((err) => {
          console.error('Failed to fetch channel permissions:', err);
          if (!cancelled) setChannelPerms(null);
        });

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeChannelId]: 0 },
      }));

      fetchPinnedMessages(session!.url, activeChannelId)
        .then((pins: Message[]) => {
          if (cancelled) return;
          setPinned(activeChannelId, pins as unknown as PinnedMessage[]);
        })
        .catch((err) => {
          console.error('Failed to load pins:', err);
        });

      socketRef.current?.emit('channel:join', activeChannelId);
      socketRef.current?.emit('mentions:read', { channelId: activeChannelId });
      socketRef.current?.emit(
        'channel:read',
        { channelId: activeChannelId },
        (res: { last_read_at?: number }) => {
          if (cancelled) return;
          if (res?.last_read_at) {
            useChatStore.getState().setChannelLastReadAt(activeChannelId, res.last_read_at);
          }
        },
      );

      return () => {
        cancelled = true;
        socketRef.current?.emit('channel:leave', activeChannelId);
        socketRef.current?.emit('typing:stop', { channelId: activeChannelId });
      };
    }
  }, [activeChannelId, reloadNonce]);

  useEffect(() => {
    if (activeDMChannelId) {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      setChannelPerms(null);
      fetchDMMessages(session!.url, activeDMChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return;
          const decrypted = msgs.map((m) => tryDecryptDM(m));
          useChatStore.getState().setMessages(activeDMChannelId, decrypted);
          useChatStore.getState().setHasMoreMessages(activeDMChannelId, hasMore);
          const lastRead = useChatStore.getState().channelLastReadAt[activeDMChannelId];
          if (lastRead && decrypted.length > 0) {
            const firstNew = decrypted.find((m) => m.created_at > lastRead);
            newMessagesRef.current = firstNew ? firstNew.id : null;
          } else {
            newMessagesRef.current = null;
          }
        })
        .catch((err) => {
          console.error('Failed to load messages:', err);
          if (!cancelled) setLoadError('Failed to load messages');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeDMChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeDMChannelId]: 0 },
      }));

      socketRef.current?.emit('channel:join', activeDMChannelId);
      socketRef.current?.emit(
        'dm:read',
        { channelId: activeDMChannelId },
        (res: { last_read_at?: number }) => {
          if (cancelled) return;
          if (res?.last_read_at) {
            useChatStore.getState().setChannelLastReadAt(activeDMChannelId, res.last_read_at);
          }
        },
      );

      return () => {
        cancelled = true;
        socketRef.current?.emit('channel:leave', activeDMChannelId);
        socketRef.current?.emit('typing:stop', { channelId: activeDMChannelId });
      };
    }
  }, [activeDMChannelId, tryDecryptDM, reloadNonce]);

  // Re-decrypt already-loaded DM messages when channel keys arrive/change.
  useEffect(() => {
    if (!activeDMChannelId) return;
    const store = useChatStore.getState();
    const msgs = store.messages[activeDMChannelId];
    if (!msgs || msgs.length === 0) return;
    const decrypted = msgs.map((m) => tryDecryptDM(m));
    const needsUpdate = decrypted.some((d, i) => d.content !== msgs[i].content);
    if (needsUpdate) {
      store.setMessages(activeDMChannelId, decrypted);
    }
  }, [dmChannels, tryDecryptDM, activeDMChannelId]);

  useEffect(() => {
    if (activeGroupDMChannelId) {
      let cancelled = false;
      setLoading(true);
      setLoadError(null);
      setChannelPerms(null);
      fetchGroupDMMessages(session!.url, activeGroupDMChannelId)
        .then(({ messages: msgs, hasMore }) => {
          if (cancelled) return;
          const decrypted = msgs.map((m) => tryDecryptGroupDM(m));
          useChatStore.getState().setMessages(activeGroupDMChannelId, decrypted);
          useChatStore.getState().setHasMoreMessages(activeGroupDMChannelId, hasMore);
          const lastRead = useChatStore.getState().channelLastReadAt[activeGroupDMChannelId];
          if (lastRead && decrypted.length > 0) {
            const firstNew = decrypted.find((m) => m.created_at > lastRead);
            newMessagesRef.current = firstNew ? firstNew.id : null;
          } else {
            newMessagesRef.current = null;
          }
        })
        .catch((err) => {
          console.error('Failed to load messages:', err);
          if (!cancelled) setLoadError('Failed to load messages');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      useChatStore.setState((state) => ({
        unreadCounts: { ...state.unreadCounts, [activeGroupDMChannelId]: 0 },
        mentionCounts: { ...state.mentionCounts, [activeGroupDMChannelId]: 0 },
      }));

      socketRef.current?.emit('channel:join', activeGroupDMChannelId);
      socketRef.current?.emit(
        'group-dm:read',
        { channelId: activeGroupDMChannelId },
        (res: { last_read_at?: number }) => {
          if (cancelled) return;
          if (res?.last_read_at) {
            useChatStore.getState().setChannelLastReadAt(activeGroupDMChannelId, res.last_read_at);
          }
        },
      );

      return () => {
        cancelled = true;
        socketRef.current?.emit('channel:leave', activeGroupDMChannelId);
        socketRef.current?.emit('typing:stop', { channelId: activeGroupDMChannelId });
      };
    }
  }, [activeGroupDMChannelId, tryDecryptGroupDM, reloadNonce]);

  // Re-decrypt already-loaded group-DM messages when member keys arrive/change.
  useEffect(() => {
    if (!activeGroupDMChannelId) return;
    const store = useChatStore.getState();
    const msgs = store.messages[activeGroupDMChannelId];
    if (!msgs || msgs.length === 0) return;
    const decrypted = msgs.map((m) => tryDecryptGroupDM(m));
    const needsUpdate = decrypted.some((d, i) => d.content !== msgs[i].content);
    if (needsUpdate) {
      store.setMessages(activeGroupDMChannelId, decrypted);
    }
  }, [groupDMChannels, tryDecryptGroupDM, activeGroupDMChannelId]);

  const loadMoreMessages = useCallback(() => {
    const channelId = activeAnyChannelId;
    if (!channelId || !session) return;
    const store = useChatStore.getState();
    const channelMessages = store.messages[channelId] || [];
    if (!store.hasMoreMessages[channelId] || channelMessages.length === 0) return;
    if (store.loadingMoreMessages[channelId]) return;
    const oldestId = channelMessages[0].id;
    if (!oldestId) return;
    store.setLoadingMoreMessages(channelId, true);
    store.setLoadMoreError(channelId, null);
    (async () => {
      try {
        const { messages: olderMsgs, hasMore } =
          channelId === activeDMChannelId
            ? await fetchDMMessages(session.url, channelId, 50, oldestId)
            : channelId === activeGroupDMChannelId
              ? await fetchGroupDMMessages(session.url, channelId, 50, oldestId)
              : await fetchMessages(session.url, channelId, 50, oldestId);
        if (olderMsgs.length === 0) {
          store.setHasMoreMessages(channelId, false);
          return;
        }
        const beforeLen = (store.messages[channelId] || []).length;
        const decrypted =
          channelId === activeDMChannelId
            ? olderMsgs.map((m) => tryDecryptDM(m))
            : channelId === activeGroupDMChannelId
              ? olderMsgs.map((m) => tryDecryptGroupDM(m))
              : olderMsgs;
        store.prependMessages(channelId, decrypted);
        const afterLen = (store.messages[channelId] || []).length;
        store.setHasMoreMessages(channelId, hasMore && afterLen > beforeLen);
      } catch (err) {
        console.error('Failed to load more messages:', err);
        store.setLoadMoreError(channelId, 'Failed to load older messages');
        store.setHasMoreMessages(channelId, true);
      } finally {
        store.setLoadingMoreMessages(channelId, false);
      }
    })();
  }, [
    activeChannelId,
    activeDMChannelId,
    activeGroupDMChannelId,
    session,
    tryDecryptDM,
    tryDecryptGroupDM,
  ]);

  const retryLoadMoreMessages = useCallback(() => {
    const channelId = activeAnyChannelId;
    if (!channelId) return;
    const store = useChatStore.getState();
    store.setHasMoreMessages(channelId, true);
    store.setLoadMoreError(channelId, null);
    loadMoreMessages();
  }, [activeChannelId, activeDMChannelId, activeGroupDMChannelId, loadMoreMessages]);

  return {
    loading,
    loadError,
    channelPerms,
    newMessagesRef,
    loadMoreMessages,
    retryLoadMoreMessages,
    reloadMessages,
  };
}
