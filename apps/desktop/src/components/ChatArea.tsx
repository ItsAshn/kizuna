import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import type { Socket } from 'socket.io-client';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import { useServerStore } from '../store/serverStore';
import { useChatStore } from '../store/chatStore';
import { useCallStore } from '../store/callStore';
import { useMobile } from '../hooks/useMobile';
import { useKeyboard } from '../hooks/useKeyboard';
import { useHaptics } from '../hooks/useHaptics';
import {
  sendMessage,
  sendDMMessage,
  sendGroupDMMessage,
  deleteMessage,
  editMessage,
  deleteDMMessage,
  deleteGroupDMMessage,
  editDMMessage,
  editGroupDMMessage,
  fetchRoles,
  pinMessage,
  unpinMessage,
  createThread,
  createPoll,
  createDMPoll,
  createGroupDMPoll,
} from '@kizuna/shared';
import { getSecretKey } from '../store/keyStore';
import {
  Lock,
  Paperclip,
  Send,
  ShieldCheck,
  ShieldAlert,
  Sticker,
  Phone,
  ChevronLeft,
  Users,
  Pin,
  MessageSquare,
  Mic,
  Square,
  Trash2,
  Search,
  Settings,
  Image as ImageIcon,
  BarChart3,
} from 'lucide-react';
import type { Message, Member, CustomRole } from '@kizuna/shared';
import { runChatCommand } from '../lib/chatCommands';
import { useComposerAutocomplete, MENTION_LIMIT } from '../hooks/useComposerAutocomplete';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { useChatCrypto } from '../hooks/useChatCrypto';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { useAttachmentUpload } from '../hooks/useAttachmentUpload';
import { useFormattingToolbar } from '../hooks/useFormattingToolbar';
import { useNotificationStore } from '../store/notificationStore';
import MessageBubble from './MessageBubble';
import GifPicker from './GifPicker';
import Skeleton from './Skeleton';
import Lightbox from './Lightbox';
import SearchBar from './SearchBar';
import PinnedMessagesModal from './PinnedMessagesModal';
import EnvStatus from './EnvStatus';
import GroupDMSettingsModal from './GroupDMSettingsModal';
import IconButton from './ui/IconButton';
import MediaGallery from './MediaGallery';
import PollPanel from './PollPanel';
import './ChatArea.css';

interface ChatAreaProps {
  socketRef: MutableRefObject<Socket | null>;
  onStartDMCall?: (dmChannelId: string, otherUserId: string, otherUsername: string) => void;
  onEndDMCall?: () => void;
  onBackToSidebar?: () => void;
  onToggleMembers?: () => void;
  membersOpen?: boolean;
  onOpenEnvWizard?: () => void;
}

function parsePollArgs(input: string): string[] {
  if (input.includes('|')) {
    return input
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const parts: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1);
      if (end !== -1) {
        parts.push(input.slice(i + 1, end).trim());
        i = end + 1;
        continue;
      }
    }
    const nextSpace = input.indexOf(' ', i);
    if (nextSpace === -1) {
      const word = input.slice(i).trim();
      if (word) parts.push(word);
      break;
    }
    const word = input.slice(i, nextSpace).trim();
    if (word) parts.push(word);
    i = nextSpace + 1;
  }
  return parts;
}

function hasDeletePermission(
  members: Member[],
  currentUserId: string,
  currentUserRole?: string,
): boolean {
  if (currentUserRole === 'admin') return true;
  const me = members.find((m) => m.id === currentUserId);
  if (!me) return false;
  return (
    me.custom_roles?.some((r) => r.permissions?.delete_messages === true || r.is_admin) ?? false
  );
}

function formatDateSeparator(date: Date): string {
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === now.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const EMPTY_MSGS: Message[] = [];

export default function ChatArea({
  socketRef,
  onStartDMCall,
  onEndDMCall,
  onBackToSidebar,
  onToggleMembers,
  membersOpen,
  onOpenEnvWizard,
}: ChatAreaProps) {
  const session = useServerStore((s) => s.activeSession);
  const isMobile = useMobile();
  const channels = useChatStore((s) => s.channels);
  const dmChannels = useChatStore((s) => s.dmChannels);
  const groupDMChannels = useChatStore((s) => s.groupDMChannels);
  const members = useChatStore((s) => s.members);
  const activeChannelId = useChatStore((s) => s.activeChannelId);
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId);
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId);
  const channelMessages = useChatStore(
    (s) => (activeChannelId ? s.messages[activeChannelId] : undefined) ?? EMPTY_MSGS,
  );
  const dmMessages = useChatStore(
    (s) => (activeDMChannelId ? s.messages[activeDMChannelId] : undefined) ?? EMPTY_MSGS,
  );
  const groupDMMessages = useChatStore(
    (s) => (activeGroupDMChannelId ? s.messages[activeGroupDMChannelId] : undefined) ?? EMPTY_MSGS,
  );
  const addMessage = useChatStore((s) => s.addMessage);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const loadingMoreMessages = useChatStore((s) => s.loadingMoreMessages);
  const loadMoreErrors = useChatStore((s) => s.loadMoreErrors);
  const pendingMention = useChatStore((s) => s.pendingMention);
  const setPendingMention = useChatStore((s) => s.setPendingMention);
  const pinnedMessages = useChatStore((s) => s.pinnedMessages);
  const setActiveChannel = useChatStore((s) => s.setActiveChannel);
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel);
  const setActiveGroupDMChannel = useChatStore((s) => s.setActiveGroupDMChannel);
  const threadPanelVisible = useChatStore((s) => s.threadPanelVisible);
  const setThreadPanelVisible = useChatStore((s) => s.setThreadPanelVisible);
  const dmCallStatus = useCallStore((s) => s.dmCallStatus);
  const dmCallChannelId = useCallStore((s) => s.dmCallChannelId);
  const activeAnyChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId || null;
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<{
    messageId: string;
    username: string;
    content: string;
  } | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false);
  const [pollPanelOpen, setPollPanelOpen] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const sendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastCountAtBottom = useRef(0);
  const prevChannelKeyRef = useRef<string | null>(null);
  const [lightboxImages, setLightboxImages] = useState<{ url: string; filename: string }[] | null>(
    null,
  );
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [showGroupDMSettings, setShowGroupDMSettings] = useState(false);
  const [mentionableRoles, setMentionableRoles] = useState<CustomRole[]>([]);
  useKeyboard();
  const haptics = useHaptics();
  const { tryDecryptDM, tryDecryptGroupDM, encryptOutgoing } = useChatCrypto(session);

  const sendToActiveChannel = useCallback(
    async (plain: string, attIds?: string[], replyToId?: string): Promise<Message | null> => {
      if (!session) return null;
      if (activeChannelId) {
        return sendMessage(session.url, activeChannelId, plain, attIds, replyToId);
      }
      if (activeDMChannelId) {
        const { content, encrypted } = await encryptOutgoing(plain);
        const message = await sendDMMessage(
          session.url,
          activeDMChannelId,
          content,
          encrypted,
          attIds,
        );
        return encrypted ? { ...message, content: plain } : message;
      }
      if (activeGroupDMChannelId) {
        const { content, encrypted } = await encryptOutgoing(plain);
        const message = await sendGroupDMMessage(
          session.url,
          activeGroupDMChannelId,
          content,
          encrypted,
          attIds,
        );
        return encrypted ? { ...message, content: plain } : message;
      }
      return null;
    },
    [session, activeChannelId, activeDMChannelId, activeGroupDMChannelId, encryptOutgoing],
  );

  const {
    loading,
    loadError,
    channelPerms,
    newMessagesRef,
    loadMoreMessages,
    retryLoadMoreMessages,
    reloadMessages,
  } = useChannelMessages({ session, socketRef, tryDecryptDM, tryDecryptGroupDM });

  const {
    uploading,
    uploadProgress,
    pendingFile,
    pendingPreviewUrl,
    pendingAttachmentId,
    setPendingAttachmentId,
    isDragOver,
    fileInputRef,
    handleFileSelect,
    cancelUpload,
    clearPendingFile,
    handleUpload,
    handleVoiceRecordingComplete,
    handleDragOver,
    handleDragLeave,
    handlePaste,
    handleDrop,
  } = useAttachmentUpload({
    session,
    activeAnyChannelId,
    atBottom,
    input,
    setInput,
    setSendError,
    sendToActiveChannel,
    addMessage,
    virtuosoRef,
    lastCountAtBottom,
    inputRef,
  });

  const { formatSel, toolbarCoords, mirrorRef, applyFormat, handleSelect, clearSelection } =
    useFormattingToolbar(inputRef, input, setInput);

  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);

  const canDeleteAny =
    activeChannelId && session
      ? hasDeletePermission(members, session.user.id, session.user.role)
      : false;
  const canCall =
    session?.user.permissions?.initiate_dm_calls === true || session?.user.role === 'admin';

  const mentionCandidates = useMemo(
    () => ['everyone', 'here', ...mentionableRoles.map((r) => r.name), ...members.map((m) => m.username)],
    [mentionableRoles, members],
  );

  const autocomplete = useComposerAutocomplete({
    input,
    setInput,
    inputRef,
    mentionCandidates,
    user: session?.user ?? null,
    slashEnabled: !!activeAnyChannelId,
  });
  const { mention, emoji: emojiAutocomplete, slash } = autocomplete;

  useEffect(() => {
    if (session) {
      fetchRoles(session.url)
        .then((roles) => {
          setMentionableRoles(roles.filter((r) => r.mentionable));
        })
        .catch((err) => {
          console.error('Failed to fetch mentionable roles:', err);
        });
    }
  }, [session]);

  // Draft persistence: save when leaving a channel, restore when entering
  useEffect(() => {
    const currentKey = activeAnyChannelId;
    const prevKey = prevChannelKeyRef.current;
    if (prevKey !== currentKey) {
      setSendError(null);
      if (prevKey !== null) {
        const currentInput = inputRef.current?.value ?? '';
        useChatStore.getState().setChannelDraft(prevKey, currentInput);
      }
      if (currentKey !== null) {
        const draft = useChatStore.getState().channelDrafts[currentKey] || '';
        setInput(draft);
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            if (draft)
              inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
          }
        });
      }
      prevChannelKeyRef.current = currentKey;
    }
  }, [activeChannelId, activeDMChannelId, activeGroupDMChannelId]);

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch((v) => !v);
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    return () => {
      if (typingTimeout.current) {
        clearTimeout(typingTimeout.current);
      }
    };
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setInput(val);
      if (sendError) setSendError(null);

      const cursor = e.target.selectionStart ?? val.length;
      autocomplete.onInputChange(val, cursor);

      const el = inputRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }

      const channelId = activeAnyChannelId;
      if (channelId && session) {
        if (typingTimeout.current) {
          clearTimeout(typingTimeout.current);
        } else {
          socketRef.current?.emit('typing:start', { channelId });
        }
        typingTimeout.current = setTimeout(() => {
          socketRef.current?.emit('typing:stop', { channelId });
          typingTimeout.current = null;
        }, 3000);
      }
    },
    [sendError, activeAnyChannelId, session, autocomplete],
  );

  useEffect(() => {
    if (pendingMention) {
      mention.insert(pendingMention);
      setPendingMention(null);
    }
  }, [pendingMention]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (autocomplete.onKeyDown(e)) return;
    // On mobile, Enter inserts a newline; sending is done via the send button.
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      handleSend();
    }
  };

  const performSend = async () => {
    if ((!input.trim() && !pendingFile) || !session) return;

    if (pendingFile) {
      await handleUpload();
      return;
    }

    let commandContent: string | null = null;
    if (input.trim().startsWith('/')) {
      const result = await runChatCommand(input.trim(), {
        serverUrl: session.url,
        user: session.user,
        members,
        notify: (title, body) =>
          useNotificationStore.getState().addNotification({ type: 'announce', title, body }),
      });
      if (result.kind === 'handled') {
        setInput('');
        setSendError(null);
        autocomplete.clear();
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
      if (result.kind === 'compose') {
        commandContent = result.content;
      }

      // /poll is handled here because it needs channelId from component scope
      const trimmedInput = input.trim();
      const pollChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
      if (trimmedInput.startsWith('/poll ') && pollChannelId) {
        const pollArgs = trimmedInput.slice(6);
        const parts = parsePollArgs(pollArgs);
        if (parts.length < 3) {
          setSendError('Usage: /poll "question" option1 option2 [option3 ...]');
          return;
        }
        const [question, ...options] = parts;
        try {
          if (activeDMChannelId) {
            await createDMPoll(session.url, activeDMChannelId, question, options);
          } else if (activeGroupDMChannelId) {
            await createGroupDMPoll(session.url, activeGroupDMChannelId, question, options);
          } else {
            await createPoll(session.url, activeChannelId!, question, options);
          }
          setInput('');
          setSendError(null);
          if (inputRef.current) inputRef.current.style.height = 'auto';
        } catch (err: unknown) {
          setSendError(
            (err as { response?: { data?: { error?: string } }; message?: string })?.response?.data
              ?.error ?? 'Failed to create poll',
          );
        }
        return;
      }
    }

    const channelId = activeAnyChannelId;
    if (!channelId) return;

    socketRef.current?.emit('typing:stop', { channelId });

    const wasAtBottom = atBottom;
    const rawInput = input;
    const outgoing = commandContent ?? rawInput.trim();
    const attIds = pendingAttachmentId ? [pendingAttachmentId] : undefined;
    const replyToId = replyTo?.messageId;

    // Clear the composer before the request so a slow send doesn't wipe text typed meanwhile.
    setInput('');
    autocomplete.clear();
    setSendError(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    try {
      const message = await sendToActiveChannel(outgoing, attIds, replyToId);
      if (!message) return;
      setPendingAttachmentId(null);
      addMessage(message.channel_id || channelId, message);
      setReplyTo(null);
      haptics.tap();
      inputRef.current?.focus();
      if (!wasAtBottom) {
        requestAnimationFrame(() => {
          const msgs = useChatStore.getState().messages[channelId] || [];
          if (msgs.length > 0) {
            virtuosoRef.current?.scrollToIndex(msgs.length - 1);
          }
          lastCountAtBottom.current = msgs.length;
        });
      }
    } catch (err: unknown) {
      // Restore the message so a failed send doesn't lose it.
      setInput(rawInput);
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.style.height = 'auto';
          inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`;
        }
      });
      const e = err as {
        response?: { status?: number; data?: { error?: string } };
        message?: string;
      };
      const status = e?.response?.status;
      const serverMsg = e?.response?.data?.error;
      if (status === 403) setSendError(serverMsg || 'You do not have permission to send messages');
      else setSendError('Failed to send message. Try again.');
    }
  };

  const handleSend = async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      await performSend();
    } finally {
      sendingRef.current = false;
    }
  };

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      if (!session) return;
      const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
      if (!channelId) return;
      try {
        if (activeDMChannelId) {
          await deleteDMMessage(session.url, messageId);
        } else if (activeGroupDMChannelId) {
          await deleteGroupDMMessage(session.url, messageId);
        } else {
          await deleteMessage(session.url, messageId);
        }
      } catch (err) {
        console.error('Failed to delete message:', err);
      }
    },
    [session, activeChannelId, activeDMChannelId, activeGroupDMChannelId],
  );

  const handleBulkDelete = useCallback(async () => {
    if (!session || selectedMessages.size === 0 || !activeChannelId) return;
    const count = selectedMessages.size;
    if (!confirm(`Delete ${count} message${count === 1 ? '' : 's'}? This cannot be undone.`))
      return;
    setBulkDeleting(true);
    try {
      const ids = [...selectedMessages];
      const results = await Promise.allSettled(ids.map((id) => deleteMessage(session.url, id)));
      const failedIds = ids.filter((_, i) => results[i].status === 'rejected');
      setSelectedMessages(new Set(failedIds));
      if (failedIds.length > 0) {
        console.error('Bulk delete failed for', failedIds.length, 'messages');
        useNotificationStore.getState().addNotification({
          type: 'announce',
          title: 'Bulk delete',
          body: `${failedIds.length} of ${count} messages could not be deleted. They remain selected.`,
        });
      }
    } finally {
      setBulkDeleting(false);
    }
  }, [session, selectedMessages, activeChannelId]);

  const toggleMessageSelection = useCallback((messageId: string) => {
    setSelectedMessages((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const { recording, recordingTime, startRecording, stopRecording } = useVoiceRecorder(
    handleVoiceRecordingComplete,
  );

  const handleEditMessage = useCallback(
    async (messageId: string, content: string) => {
      if (!session) return;
      const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
      if (!channelId) return;
      try {
        if (activeDMChannelId) {
          const { content: sendContent, encrypted } = await encryptOutgoing(content);
          await editDMMessage(session.url, messageId, sendContent, encrypted);
        } else if (activeGroupDMChannelId) {
          const { content: sendContent, encrypted } = await encryptOutgoing(content);
          await editGroupDMMessage(session.url, messageId, sendContent, encrypted);
        } else {
          await editMessage(session.url, messageId, content);
        }
      } catch (err) {
        console.error('Failed to edit message:', err);
      }
    },
    [session, activeChannelId, activeDMChannelId, activeGroupDMChannelId, encryptOutgoing],
  );

  const handlePinMessage = useCallback(
    async (messageId: string) => {
      if (!session || !activeChannelId) return;
      try {
        await pinMessage(session.url, activeChannelId, messageId);
      } catch (err) {
        console.error('Failed to pin message:', err);
      }
    },
    [session, activeChannelId],
  );

  const handleUnpinMessage = useCallback(
    async (messageId: string) => {
      if (!session || !activeChannelId) return;
      try {
        await unpinMessage(session.url, activeChannelId, messageId);
      } catch (err) {
        console.error('Failed to unpin message:', err);
      }
    },
    [session, activeChannelId],
  );

  const handleCreateThread = useCallback(
    async (messageId: string, name: string) => {
      if (!session || !activeChannelId) return;
      try {
        const result = await createThread(session.url, activeChannelId, name, messageId);
        useChatStore.getState().setActiveThreadId(result.id);
      } catch (err) {
        console.error('Failed to create thread:', err);
      }
    },
    [session, activeChannelId],
  );

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const activeGroupDM = groupDMChannels.find((g) => g.id === activeGroupDMChannelId);
  const headerTitle =
    activeChannel?.name || activeDM?.other_display_name || activeGroupDM?.name || 'Kizuna';
  const displayMessages = activeDMChannelId
    ? dmMessages
    : activeGroupDMChannelId
      ? groupDMMessages
      : channelMessages;

  // Screen-reader announcement for incoming messages. Virtuoso mounts/unmounts items on
  // scroll, so aria-live on the scrolling container itself fires unreliably — this is a
  // dedicated off-screen region updated only when a genuinely new message arrives.
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const lastAnnouncedIdRef = useRef<string | null>(null);
  const announceChannelKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const last = displayMessages[displayMessages.length - 1];
    if (announceChannelKeyRef.current !== activeAnyChannelId) {
      // Switching channels — don't announce the channel's existing history.
      announceChannelKeyRef.current = activeAnyChannelId;
      lastAnnouncedIdRef.current = last?.id ?? null;
      return;
    }
    if (!last || last.id === lastAnnouncedIdRef.current) return;
    lastAnnouncedIdRef.current = last.id;
    if (last.user_id === session?.user.id) return;
    const author = last.display_name || last.username || 'Someone';
    const preview = last.content.length > 140 ? last.content.slice(0, 140) + '…' : last.content;
    setLiveAnnouncement(`${author}: ${preview}`);
  }, [displayMessages, activeAnyChannelId, session?.user.id]);

  const lightboxImageMap = useMemo(() => {
    const images: { url: string; filename: string }[] = [];
    const urlToIndex = new Map<string, number>();
    const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
    const urlRe = /(https?:\/\/[^\s]+)/g;
    for (const m of displayMessages) {
      let match;
      while ((match = imgRe.exec(m.content)) !== null) {
        const u = match[2];
        if (
          u.startsWith('/uploads/') ||
          u.startsWith('/api/attachments/') ||
          u.startsWith('/api/gifs/') ||
          u.startsWith('http')
        ) {
          const resolved = session?.url && u.startsWith('/') ? `${session.url}${u}` : u;
          if (!urlToIndex.has(resolved)) {
            urlToIndex.set(resolved, images.length);
            images.push({ url: resolved, filename: match[1] || 'image' });
          }
        }
      }
      while ((match = urlRe.exec(m.content)) !== null) {
        const u = match[1];
        if (/\.(jpg|jpeg|png|gif|webp)$/i.test(u)) {
          if (!urlToIndex.has(u)) {
            urlToIndex.set(u, images.length);
            images.push({ url: u, filename: u.split('/').pop() || 'image' });
          }
        }
      }
    }
    return { images, urlToIndex };
  }, [displayMessages, session?.url]);

  useEffect(() => {
    if (atBottom) {
      lastCountAtBottom.current = displayMessages.length;
    }
  }, [atBottom, displayMessages.length]);

  useEffect(() => {
    lastCountAtBottom.current = displayMessages.length;
  }, [activeChannelId, activeDMChannelId, activeGroupDMChannelId]);
  const typingList =
    typingUsers[activeAnyChannelId || '']?.filter((u) => u !== session?.user.username) || [];
  const typingText =
    typingList.length === 1
      ? `${typingList[0]} is typing...`
      : typingList.length > 1
        ? `${typingList.length} people are typing...`
        : '';
  const dmHasKey = activeDMChannelId ? !!(activeDM?.other_public_key && getSecretKey()) : false;
  const composerTarget = activeDMChannelId
    ? `@${activeDM?.other_display_name ?? 'user'}`
    : activeGroupDMChannelId
      ? (activeGroupDM?.name ?? 'group')
      : `#${activeChannel?.name ?? 'channel'}`;
  const inputMaxLen = activeDMChannelId ? 2700 : 4000;
  const inputRemaining = inputMaxLen - input.length;
  const showCharCounter = inputRemaining < 500;
  const cantWrite = channelPerms?.locked && !channelPerms?.can_write;

  const handleJumpToMessage = useCallback(
    (messageId: string, targetChannelId: string) => {
      setShowSearch(false);

      const currentChannelId = activeAnyChannelId;

      if (targetChannelId !== currentChannelId) {
        const isDM = dmChannels.some((d) => d.id === targetChannelId);
        const isGroupDM = groupDMChannels.some((g) => g.id === targetChannelId);
        if (isDM) {
          setActiveDMChannel(targetChannelId);
        } else if (isGroupDM) {
          setActiveGroupDMChannel(targetChannelId);
        } else {
          setActiveChannel(targetChannelId);
        }
      }

      const tryScroll = (attempts: number) => {
        // Read fresh from the store — this closure outlives the channel switch,
        // so `displayMessages` here would be the previous channel's list.
        const msgs = useChatStore.getState().messages[targetChannelId] || [];
        const idx = msgs.findIndex((m) => m.id === messageId);
        if (idx >= 0) {
          virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' });
          const el = document.getElementById(`msg-${messageId}`);
          if (el) {
            el.style.transition = 'background-color 0.3s ease';
            el.style.backgroundColor = 'var(--bg-highlight, rgba(108, 90, 245, 0.12))';
            setTimeout(() => {
              el.style.backgroundColor = '';
            }, 2500);
          }
          return;
        }
        if (attempts < 15) {
          setTimeout(() => tryScroll(attempts + 1), 200);
        }
      };

      if (targetChannelId !== currentChannelId) {
        setTimeout(() => tryScroll(0), 600);
      } else {
        tryScroll(0);
      }
    },
    [
      activeAnyChannelId,
      dmChannels,
      groupDMChannels,
      setActiveChannel,
      setActiveDMChannel,
      setActiveGroupDMChannel,
    ],
  );

  const renderMessageItem = useCallback(
    (_index: number, msg: Message) => {
      const msgIdx = _index;
      const prevMsg = msgIdx > 0 ? displayMessages[msgIdx - 1] : null;
      const msgDate = new Date(msg.created_at).toDateString();
      const prevDate = prevMsg ? new Date(prevMsg.created_at).toDateString() : '';
      const isOwn = msg.user_id === session?.user.id;
      const isGrouped = prevMsg?.user_id === msg.user_id && !isOwn;
      const messageCanDelete = isOwn || canDeleteAny;
      const isFirstNew = newMessagesRef.current === msg.id;

      return (
        <div id={`msg-${msg.id}`}>
          {msgDate !== prevDate && (
            <div className="msg-bubble__date-separator">
              <span className="msg-bubble__date-label">
                {formatDateSeparator(new Date(msg.created_at))}
              </span>
            </div>
          )}
          {isFirstNew && (
            <div className="chat-area__new-messages-separator">
              <span className="chat-area__new-messages-label">New Messages</span>
            </div>
          )}
          <MessageBubble
            message={msg}
            isOwn={isOwn}
            isGrouped={isGrouped}
            currentUsername={session?.user.username}
            canDelete={messageCanDelete}
            isSelected={selectedMessages.has(msg.id)}
            onSelect={toggleMessageSelection}
            onDelete={handleDeleteMessage}
            canEdit={isOwn}
            onEdit={handleEditMessage}
            serverUrl={session?.url}
            onReply={(replyMsg) => {
              setReplyTo({
                messageId: replyMsg.id,
                username: replyMsg.display_name || replyMsg.username || 'Unknown',
                content: replyMsg.content,
              });
              inputRef.current?.focus();
            }}
            onPin={activeChannelId ? handlePinMessage : undefined}
            onUnpin={activeChannelId ? handleUnpinMessage : undefined}
            isPinned={
              activeChannelId
                ? (pinnedMessages[activeChannelId]?.some((p) => p.messageId === msg.id) ?? false)
                : undefined
            }
            onCreateThread={activeChannelId ? handleCreateThread : undefined}
            onImageClick={(imageUrl) => {
              setLightboxImages(lightboxImageMap.images);
              setLightboxIndex(lightboxImageMap.urlToIndex.get(imageUrl) ?? 0);
            }}
          />
        </div>
      );
    },
    [
      displayMessages,
      session,
      canDeleteAny,
      activeChannelId,
      activeDMChannelId,
      setReplyTo,
      handleDeleteMessage,
      handleEditMessage,
      handlePinMessage,
      handleUnpinMessage,
      handleCreateThread,
      pinnedMessages,
      lightboxImageMap,
    ],
  );

  return (
    <div
      id="main-content"
      className="chat-area"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="chat-area__drop-overlay">
          <div className="chat-area__drop-overlay-content">
            <span className="chat-area__drop-overlay-icon">&#x2913;</span>
            <span className="chat-area__drop-overlay-text">Drop files to upload</span>
          </div>
        </div>
      )}
      {selectedMessages.size > 0 && (
        <div className="chat-area__bulk-bar">
          <span>{selectedMessages.size} selected</span>
          {canDeleteAny && activeChannelId && (
            <button
              className="chat-area__bulk-bar-delete"
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              aria-label={`Delete ${selectedMessages.size} selected messages`}
            >
              {bulkDeleting ? 'Deleting...' : `Delete ${selectedMessages.size}`}
            </button>
          )}
          <button
            className="chat-area__bulk-bar-cancel"
            onClick={() => setSelectedMessages(new Set())}
            aria-label="Cancel selection"
          >
            Cancel
          </button>
        </div>
      )}
      <div className="chat-area__header">
        {isMobile && onBackToSidebar && (
          <button
            className="chat-area__mobile-back"
            onClick={onBackToSidebar}
            aria-label="Back to channels"
          >
            <ChevronLeft className="icon-sm" />
          </button>
        )}
        {!isMobile && onOpenEnvWizard && (
          <div className="chat-area__header-env">
            <EnvStatus onOpenWizard={onOpenEnvWizard} />
          </div>
        )}
        <span className="chat-area__header-prefix">
          {activeDMChannelId || activeGroupDMChannelId ? '@' : '#'}
        </span>
        <h2 className="chat-area__header-title">{headerTitle}</h2>
        {activeDMChannelId && dmHasKey && (
          <span className="chat-area__encrypted-badge" title="End-to-end encrypted">
            <ShieldCheck size={14} />
          </span>
        )}
        {activeDMChannelId && !dmHasKey && activeDM?.other_public_key !== undefined && (
          <span
            className="chat-area__encrypted-badge chat-area__encrypted-badge--warn"
            title="Not encrypted - keys unavailable"
          >
            <ShieldAlert size={14} />
          </span>
        )}
        {activeChannel?.topic && (
          <span className="chat-area__header-topic">{activeChannel.topic}</span>
        )}
        {channelPerms?.locked && (
          <span
            className={`chat-area__locked-badge ${channelPerms.can_write ? 'chat-area__locked-badge--can-write' : ''}`}
          >
            <Lock size={12} className="chat-area__locked-badge-icon" />
            Locked
          </span>
        )}
        <div className="chat-area__header-actions">
          {activeDMChannelId && activeDM && canCall && (
            <button
              onClick={() => {
                if (dmCallStatus === 'active' && dmCallChannelId === activeDM.id) {
                  onEndDMCall?.();
                } else if (dmCallStatus !== 'ringing-outgoing') {
                  onStartDMCall?.(activeDM.id, activeDM.other_user_id, activeDM.other_display_name);
                }
              }}
              className={`chat-area__call-btn ${dmCallStatus === 'active' && dmCallChannelId === activeDM.id ? 'chat-area__call-btn--active' : ''}`}
              title={
                dmCallStatus === 'active' && dmCallChannelId === activeDM.id
                  ? 'End call'
                  : dmCallStatus === 'ringing-outgoing' && dmCallChannelId === activeDM.id
                    ? 'Calling...'
                    : 'Start call'
              }
              disabled={dmCallStatus === 'ringing-outgoing' && dmCallChannelId === activeDM.id}
            >
              <Phone className="icon-xs" />
            </button>
          )}
          {onToggleMembers && activeChannelId && (
            <button
              className={`chat-area__header-members-btn${membersOpen ? ' chat-area__header-members-btn--active' : ''}`}
              onClick={onToggleMembers}
              aria-label="Show members"
            >
              <Users className="icon-sm" />
              <span>{members.length}</span>
            </button>
          )}
          {activeAnyChannelId && (
            <IconButton
              icon={<Search className="icon-sm" />}
              label="Search messages"
              title="Search messages"
              active={showSearch}
              onClick={() => setShowSearch((v) => !v)}
            />
          )}
          {activeGroupDMChannelId &&
            activeGroupDM &&
            activeGroupDM.owner_id === session?.user.id && (
              <IconButton
                icon={<Settings className="icon-sm" />}
                label="Group settings"
                title="Group Settings"
                active={showGroupDMSettings}
                onClick={() => setShowGroupDMSettings((v) => !v)}
              />
            )}
          {activeChannelId && (
            <IconButton
              icon={<Pin className="icon-sm" />}
              label="Pinned messages"
              title="Pinned Messages"
              active={pinsOpen}
              onClick={() => setPinsOpen(true)}
            />
          )}
          {activeAnyChannelId && (
            <IconButton
              icon={<ImageIcon className="icon-sm" />}
              label="Media gallery"
              title="Media"
              active={mediaGalleryOpen}
              onClick={() => setMediaGalleryOpen(true)}
            />
          )}
          {activeAnyChannelId && (
            <IconButton
              icon={<BarChart3 className="icon-sm" />}
              label="Toggle polls"
              title="Polls"
              active={pollPanelOpen}
              onClick={() => setPollPanelOpen((v) => !v)}
            />
          )}
          {activeChannelId && (
            <IconButton
              icon={<MessageSquare className="icon-sm" />}
              label="Toggle threads"
              title="Threads"
              active={threadPanelVisible}
              onClick={() => setThreadPanelVisible(!threadPanelVisible)}
            />
          )}
        </div>
      </div>

      {showSearch && activeAnyChannelId && (
        <SearchBar
          channelId={activeAnyChannelId}
          onClose={() => setShowSearch(false)}
          onJumpToMessage={handleJumpToMessage}
        />
      )}

      <PollPanel
        serverUrl={session?.url ?? ''}
        channelId={activeAnyChannelId}
        isOpen={pollPanelOpen}
        onClose={() => setPollPanelOpen(false)}
      />

      <div className="chat-area__sr-only" aria-live="polite" aria-atomic="true">
        {liveAnnouncement}
      </div>

      <div className="chat-area__messages-wrap">
        <div className="chat-area__messages" role="log" aria-label="Messages">
          {loading && (
            <>
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="skeleton--message">
                  <Skeleton variant="circle" width={40} height={40} />
                  <div className="skeleton--message-body">
                    <Skeleton variant="text" width={120} />
                    <Skeleton variant="text" width={200 + (i % 3) * 80} />
                    {i % 2 === 0 && <Skeleton variant="text" width={140} />}
                  </div>
                </div>
              ))}
            </>
          )}
          {!loading && loadError && displayMessages.length === 0 && (
            <div className="chat-area__loading">
              <p>{loadError}. Check your connection.</p>
              <button
                className="chat-area__load-more-retry chat-area__load-more-retry--visible"
                onClick={reloadMessages}
              >
                Retry
              </button>
            </div>
          )}
          {!loading && !loadError && displayMessages.length === 0 && (
            <p className="chat-area__loading">No messages yet. Be the first to send one!</p>
          )}
          {!loading && displayMessages.length > 0 && (
            <Virtuoso
              key={activeAnyChannelId}
              ref={virtuosoRef}
              data={displayMessages}
              itemContent={renderMessageItem}
              followOutput={(isAtBottom) => (isAtBottom ? 'smooth' : false)}
              atBottomStateChange={(isAtBottom) => setAtBottom(isAtBottom)}
              startReached={loadMoreMessages}
              increaseViewportBy={{ top: 400, bottom: 200 }}
              initialTopMostItemIndex={displayMessages.length > 0 ? displayMessages.length - 1 : 0}
              style={{ flex: 1 }}
              components={{
                Header: () => {
                  const chId = activeAnyChannelId || '';
                  const loadingMore = loadingMoreMessages[chId];
                  const loadError = loadMoreErrors[chId];
                  const hasMore = hasMoreMessages[chId];
                  if (!hasMore && !loadingMore && !loadError) return null;
                  return (
                    <div className="chat-area__load-more">
                      <div
                        className={`chat-area__load-more-spinner${loadingMore ? ' chat-area__load-more-spinner--active' : ''}`}
                      >
                        <span className="chat-area__load-more-spinner-icon" />
                        <span>Loading older messages...</span>
                      </div>
                      <button
                        className={`chat-area__load-more-retry${loadError ? ' chat-area__load-more-retry--visible' : ''}`}
                        onClick={retryLoadMoreMessages}
                        tabIndex={loadError ? 0 : -1}
                      >
                        {loadError || ' '}
                      </button>
                    </div>
                  );
                },
                Footer: () =>
                  typingText ? (
                    <div className="chat-area__typing">
                      {typingText}
                      <span className="chat-area__typing-dots">
                        <span className="chat-area__typing-dot" />
                        <span className="chat-area__typing-dot" />
                        <span className="chat-area__typing-dot" />
                      </span>
                    </div>
                  ) : null,
              }}
            />
          )}
        </div>
        {!atBottom && (
          <button
            className="chat-area__scroll-bottom"
            onClick={() => {
              virtuosoRef.current?.scrollToIndex(displayMessages.length - 1);
              lastCountAtBottom.current = displayMessages.length;
            }}
            title="Jump to bottom"
          >
            ↓{' '}
            {(() => {
              if (newMessagesRef.current) {
                const newIdx = displayMessages.findIndex((m) => m.id === newMessagesRef.current);
                const count =
                  newIdx >= 0
                    ? displayMessages.length - newIdx
                    : Math.max(0, displayMessages.length - lastCountAtBottom.current);
                if (count > 0) return `${count} new`;
              } else {
                const newCount = Math.max(0, displayMessages.length - lastCountAtBottom.current);
                if (newCount > 0) return `${newCount} new`;
              }
              return null;
            })()}
          </button>
        )}
      </div>

      <div className="chat-area__input-bar">
        {slash.suggestions.length > 0 && (
          <div
            className="chat-area__mention-suggestions chat-area__slash-suggestions"
            role="listbox"
            aria-label="Command suggestions"
          >
            {slash.suggestions.map((cmd, i) => (
              <button
                key={cmd.name}
                role="option"
                aria-selected={i === slash.selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  slash.insert(cmd);
                }}
                onMouseEnter={() => slash.setSelectedIndex(i)}
                className={`chat-area__mention-suggestion ${i === slash.selectedIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
              >
                <span className="chat-area__mention-prefix">/</span>
                <span className="chat-area__slash-name">{cmd.name}</span>
                {cmd.usage && <span className="chat-area__slash-usage">{cmd.usage}</span>}
                <span className="chat-area__slash-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {mention.suggestions.length > 0 && (
          <div
            className="chat-area__mention-suggestions"
            role="listbox"
            aria-label="Mention suggestions"
          >
            {mention.suggestions.slice(0, MENTION_LIMIT).map((u, i) => {
              const mentionableRole = mentionableRoles.find((r) => r.name === u);
              const isRole = !!mentionableRole;
              return (
                <button
                  key={`${isRole ? 'role' : 'user'}:${u}`}
                  role="option"
                  aria-selected={i === mention.selectedIndex}
                  ref={(el) => {
                    mention.refs.current[i] = el;
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    mention.insert(u);
                  }}
                  onMouseEnter={() => mention.setSelectedIndex(i)}
                  className={`chat-area__mention-suggestion ${i === mention.selectedIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
                >
                  {isRole && (
                    <span
                      className="chat-area__mention-role-dot"
                      style={{ backgroundColor: mentionableRole.color }}
                    />
                  )}
                  <span className="chat-area__mention-prefix">@</span>
                  {u}
                  {isRole && <span className="chat-area__mention-group-tag">role</span>}
                  {(u === 'everyone' || u === 'here') && (
                    <span className="chat-area__mention-group-tag">group</span>
                  )}
                </button>
              );
            })}
            {mention.suggestions.length > MENTION_LIMIT && (
              <div className="chat-area__mention-capped">
                Found {mention.suggestions.length} — keep typing to narrow
              </div>
            )}
          </div>
        )}

        {emojiAutocomplete.suggestions.length > 0 && (
          <div
            className="chat-area__emoji-suggestions"
            role="listbox"
            aria-label="Emoji suggestions"
          >
            {emojiAutocomplete.suggestions.map((entry, i) => (
              <button
                key={entry.shortcode}
                role="option"
                aria-selected={i === emojiAutocomplete.selectedIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  emojiAutocomplete.insert(entry);
                }}
                onMouseEnter={() => emojiAutocomplete.setSelectedIndex(i)}
                className={`chat-area__emoji-suggestion ${i === emojiAutocomplete.selectedIndex ? 'chat-area__emoji-suggestion--selected' : ''}`}
              >
                <span className="chat-area__emoji-char">{entry.emoji}</span>
                <span className="chat-area__emoji-code">:{entry.shortcode}:</span>
              </button>
            ))}
          </div>
        )}

        {replyTo && (
          <div className="chat-area__reply-bar">
            <div className="chat-area__reply-bar-content">
              <span className="chat-area__reply-bar-label">Replying to</span>
              <span className="chat-area__reply-bar-username">@{replyTo.username}</span>
              <span className="chat-area__reply-bar-preview">
                {replyTo.content.length > 80
                  ? replyTo.content.slice(0, 80) + '...'
                  : replyTo.content}
              </span>
            </div>
            <button
              className="chat-area__reply-bar-close"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            >
              ×
            </button>
          </div>
        )}

        {pendingFile && (
          <div className="chat-area__upload-preview">
            {pendingPreviewUrl && (
              <img src={pendingPreviewUrl} alt="" className="chat-area__upload-thumbnail" />
            )}
            <div className="chat-area__upload-info">
              <p className="chat-area__upload-name">{pendingFile.name}</p>
              <p className="chat-area__upload-size">{formatFileSize(pendingFile.size)}</p>
            </div>
            {uploading ? (
              <>
                <span className="chat-area__upload-progress">
                  {uploadProgress > 0 && uploadProgress < 100
                    ? `${uploadProgress}%`
                    : 'uploading...'}
                </span>
                <button className="chat-area__upload-cancel" onClick={cancelUpload}>
                  cancel
                </button>
              </>
            ) : (
              <button
                className="chat-area__upload-cancel"
                onClick={clearPendingFile}
              >
                cancel
              </button>
            )}
          </div>
        )}

        <div className="chat-area__input-row">
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
            accept="image/*,video/*,audio/*,.pdf,.txt,.json"
          />
          <IconButton
            icon={<Paperclip size={16} />}
            label="Attach file"
            title="Attach file"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          />
          <IconButton
            icon={<Sticker size={16} />}
            label="GIFs and stickers"
            title="GIFs & Stickers"
            onClick={() => setGifPickerOpen(true)}
          />
          {activeDMChannelId && (
            <>
              <button
                className={`chat-area__mic-btn${recording ? ' chat-area__mic-btn--recording' : ''}`}
                onClick={() => (recording ? stopRecording(true) : startRecording())}
                title={recording ? 'Stop and send' : 'Record voice message'}
                aria-label={recording ? 'Stop and send voice message' : 'Record voice message'}
                disabled={cantWrite}
              >
                <Mic size={16} />
              </button>
              {recording && (
                <div className="chat-area__recording-bar">
                  <span className="chat-area__recording-dot" />
                  <span className="chat-area__recording-time">
                    {String(Math.floor(recordingTime / 60)).padStart(2, '0')}:
                    {String(recordingTime % 60).padStart(2, '0')}
                  </span>
                  <button
                    className="chat-area__recording-cancel"
                    onClick={() => stopRecording(false)}
                    title="Cancel recording"
                    aria-label="Cancel recording"
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    className="chat-area__recording-send"
                    onClick={() => stopRecording(true)}
                    title="Stop and send"
                    aria-label="Stop and send"
                  >
                    <Square size={14} />
                  </button>
                </div>
              )}
            </>
          )}
          {formatSel && toolbarCoords && (
            <div
              className="chat-area__format-toolbar"
              style={{ position: 'fixed', top: toolbarCoords.top, left: toolbarCoords.left }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button onClick={() => applyFormat('**')} title="Bold" aria-label="Bold">
                <strong>B</strong>
              </button>
              <button onClick={() => applyFormat('*')} title="Italic" aria-label="Italic">
                <em>I</em>
              </button>
              <button onClick={() => applyFormat('__')} title="Underline" aria-label="Underline">
                <u>U</u>
              </button>
              <button onClick={() => applyFormat('`')} title="Inline code" aria-label="Code">
                {'`'}
              </button>
              <button
                onClick={() => applyFormat('~~')}
                title="Strikethrough"
                aria-label="Strikethrough"
              >
                ~~
              </button>
              <button onClick={() => applyFormat('||')} title="Spoiler" aria-label="Spoiler">
                ||
              </button>
              <button onClick={() => applyFormat('> ', '')} title="Quote" aria-label="Quote">
                &gt;
              </button>
            </div>
          )}
          <div ref={mirrorRef} className="chat-area__format-mirror" aria-hidden="true" />
          <textarea
            ref={inputRef}
            className={`chat-area__input ${cantWrite ? 'chat-area__input--locked' : ''}`}
            rows={1}
            style={{ resize: 'none' }}
            placeholder={
              cantWrite
                ? `Channel locked — only admins can send messages`
                : `Message ${composerTarget}`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={handleSelect}
            onBlur={clearSelection}
            maxLength={inputMaxLen}
            disabled={cantWrite}
            aria-label={`Message ${composerTarget}`}
          />
          <button
            className="chat-area__send-btn"
            onClick={handleSend}
            disabled={(!input.trim() && !pendingFile) || uploading || cantWrite}
            aria-label="Send message"
          >
            <Send size={16} />
          </button>
        </div>
        {showCharCounter && (
          <div
            className={`chat-area__char-counter${inputRemaining < 50 ? ' chat-area__char-counter--near-limit' : ''}`}
          >
            {inputRemaining} / {inputMaxLen}
          </div>
        )}
        {sendError ? (
          <p className="chat-area__input-hint chat-area__input-hint--error">{sendError}</p>
        ) : (
          !isMobile && (
            <p className="chat-area__input-hint">
              enter to send · shift+enter for new line · @ to mention · paperclip for files
            </p>
          )
        )}
        {gifPickerOpen && session && (
          <GifPicker
            serverUrl={session.url}
            onSelect={(url, displayName, type) => {
              setInput((prev) => prev + `![${type}:${displayName}](${url})`);
              setGifPickerOpen(false);
              inputRef.current?.focus();
            }}
            onClose={() => setGifPickerOpen(false)}
          />
        )}
      </div>

      {lightboxImages && (
        <Lightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxImages(null)}
        />
      )}

      {activeChannelId && (
        <PinnedMessagesModal
          pins={pinnedMessages[activeChannelId] || []}
          open={pinsOpen}
          onClose={() => setPinsOpen(false)}
          onJump={(messageId) => handleJumpToMessage(messageId, activeChannelId!)}
          onUnpin={handleUnpinMessage}
        />
      )}

      {showGroupDMSettings && activeGroupDM && (
        <GroupDMSettingsModal
          groupDM={activeGroupDM}
          onClose={() => setShowGroupDMSettings(false)}
        />
      )}

      {mediaGalleryOpen && (
        <MediaGallery
          images={lightboxImageMap.images}
          onOpen={(i) => {
            setLightboxImages(lightboxImageMap.images);
            setLightboxIndex(i);
          }}
          onClose={() => setMediaGalleryOpen(false)}
        />
      )}
    </div>
  );
}
