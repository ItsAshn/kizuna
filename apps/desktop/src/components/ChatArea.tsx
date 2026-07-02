import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { MutableRefObject } from 'react';
import type { Socket } from 'socket.io-client';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import { useServerStore } from '../store/serverStore';
import { useChatStore } from '../store/chatStore';
import { useCallStore } from '../store/callStore';
import { useMobile } from '../hooks/useMobile';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { useKeyboard } from '../hooks/useKeyboard';
import { useHaptics } from '../hooks/useHaptics';
import {
  fetchMessages,
  fetchDMMessages,
  fetchGroupDMMessages,
  sendMessage,
  sendDMMessage,
  sendGroupDMMessage,
  deleteMessage,
  editMessage,
  deleteDMMessage,
  deleteGroupDMMessage,
  editDMMessage,
  editGroupDMMessage,
  uploadAttachment,
  fetchChannelPermissions,
  getUserPublicKey,
  fetchRoles,
  pinMessage,
  unpinMessage,
  fetchPinnedMessages,
  createThread,
  createPoll,
} from '@kizuna/shared';
import {
  encryptDM,
  decryptDM,
  isEncryptedContent,
  encryptGroupDM,
  decryptGroupDM,
  isGroupEncryptedContent,
} from '@kizuna/shared/crypto';
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
} from 'lucide-react';
import type {
  Message,
  Member,
  DMChannelData,
  CustomRole,
  PinnedMessage,
  ChatCommand,
} from '@kizuna/shared';
import { CHAT_COMMANDS } from '@kizuna/shared';
import { runChatCommand, userCanUseCommand } from '../lib/chatCommands';
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

function getAtQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s])@([\w.-]*)$/.exec(before);
  return match ? match[1] : null;
}

function getEmojiQuery(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|[\s]):([\w+-]*)$/.exec(before);
  return match ? match[1] : null;
}

const EMOJI_LIST: { shortcode: string; emoji: string }[] = [
  { shortcode: 'smile', emoji: '😊' },
  { shortcode: 'laugh', emoji: '😂' },
  { shortcode: 'heart', emoji: '❤️' },
  { shortcode: 'thumbsup', emoji: '👍' },
  { shortcode: 'thumbsdown', emoji: '👎' },
  { shortcode: 'clap', emoji: '👏' },
  { shortcode: 'fire', emoji: '🔥' },
  { shortcode: 'star', emoji: '⭐' },
  { shortcode: 'check', emoji: '✅' },
  { shortcode: 'x', emoji: '❌' },
  { shortcode: 'warning', emoji: '⚠️' },
  { shortcode: 'question', emoji: '❓' },
  { shortcode: 'bulb', emoji: '💡' },
  { shortcode: 'rocket', emoji: '🚀' },
  { shortcode: 'party', emoji: '🎉' },
  { shortcode: 'cry', emoji: '😢' },
  { shortcode: 'angry', emoji: '😠' },
  { shortcode: 'cool', emoji: '😎' },
  { shortcode: 'wink', emoji: '😉' },
  { shortcode: 'kiss', emoji: '😘' },
  { shortcode: 'hug', emoji: '🤗' },
  { shortcode: 'pray', emoji: '🙏' },
  { shortcode: 'ok', emoji: '👌' },
  { shortcode: 'wave', emoji: '👋' },
  { shortcode: 'muscle', emoji: '💪' },
  { shortcode: 'brain', emoji: '🧠' },
  { shortcode: 'eyes', emoji: '👀' },
  { shortcode: '100', emoji: '💯' },
  { shortcode: 'tada', emoji: '🎊' },
  { shortcode: 'sunglasses', emoji: '😎' },
  { shortcode: 'sleep', emoji: '😴' },
  { shortcode: 'cat', emoji: '🐱' },
  { shortcode: 'dog', emoji: '🐶' },
  { shortcode: 'alien', emoji: '👽' },
  { shortcode: 'ghost', emoji: '👻' },
  { shortcode: 'skull', emoji: '💀' },
  { shortcode: 'pizza', emoji: '🍕' },
  { shortcode: 'coffee', emoji: '☕' },
  { shortcode: 'beer', emoji: '🍺' },
  { shortcode: 'crown', emoji: '👑' },
  { shortcode: 'gem', emoji: '💎' },
  { shortcode: 'gift', emoji: '🎁' },
  { shortcode: 'zap', emoji: '⚡' },
  { shortcode: 'rainbow', emoji: '🌈' },
  { shortcode: 'lock', emoji: '🔒' },
  { shortcode: 'key', emoji: '🔑' },
  { shortcode: 'hammer', emoji: '🔨' },
  { shortcode: 'wrench', emoji: '🔧' },
  { shortcode: 'link', emoji: '🔗' },
  { shortcode: 'pin', emoji: '📌' },
  { shortcode: 'book', emoji: '📖' },
  { shortcode: 'pencil', emoji: '✏️' },
  { shortcode: 'scissors', emoji: '✂️' },
  { shortcode: 'phone', emoji: '📱' },
  { shortcode: 'monitor', emoji: '🖥️' },
  { shortcode: 'mute', emoji: '🔇' },
  { shortcode: 'sound', emoji: '🔊' },
];

function parsePollArgs(input: string): string[] {
  if (input.includes('|')) {
    return input.split('|').map((s) => s.trim()).filter(Boolean)
  }
  const parts: string[] = []
  let i = 0
  while (i < input.length) {
    if (input[i] === '"') {
      const end = input.indexOf('"', i + 1)
      if (end !== -1) {
        parts.push(input.slice(i + 1, end).trim())
        i = end + 1
        continue
      }
    }
    const nextSpace = input.indexOf(' ', i)
    if (nextSpace === -1) {
      const word = input.slice(i).trim()
      if (word) parts.push(word)
      break
    }
    const word = input.slice(i, nextSpace).trim()
    if (word) parts.push(word)
    i = nextSpace + 1
  }
  return parts
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
  const _channelDrafts = useChatStore((s) => s.channelDrafts);
  const _setChannelDraft = useChatStore((s) => s.setChannelDraft);
  const pinnedMessages = useChatStore((s) => s.pinnedMessages);
  const setPinned = useChatStore((s) => s.setPinnedMessages);
  const setActiveChannel = useChatStore((s) => s.setActiveChannel);
  const setActiveDMChannel = useChatStore((s) => s.setActiveDMChannel);
  const setActiveGroupDMChannel = useChatStore((s) => s.setActiveGroupDMChannel);
  const threadPanelVisible = useChatStore((s) => s.threadPanelVisible);
  const setThreadPanelVisible = useChatStore((s) => s.setThreadPanelVisible);
  const dmCallStatus = useCallStore((s) => s.dmCallStatus);
  const dmCallChannelId = useCallStore((s) => s.dmCallChannelId);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [pendingAttachmentId, setPendingAttachmentId] = useState<string | null>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [atIndex, setAtIndex] = useState(0);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedEmojiIndex, setSelectedEmojiIndex] = useState(0);
  const [replyTo, setReplyTo] = useState<{
    messageId: string;
    username: string;
    content: string;
  } | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [mediaGalleryOpen, setMediaGalleryOpen] = useState(false);
  const [selectedMessages, setSelectedMessages] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [formatSel, setFormatSel] = useState<{ start: number; end: number } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [channelPerms, setChannelPerms] = useState<{
    can_write: boolean;
    locked: boolean;
    write_role_name: string | null;
  } | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionRefs = useRef<(HTMLButtonElement | null)[]>([]);
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
  const newMessagesRef = useRef<string | null>(null);
  useSwipeBack(chatAreaRef, onBackToSidebar || (() => {}), !!isMobile && !!onBackToSidebar);
  useKeyboard();
  const haptics = useHaptics();
  const tryDecryptDM = useCallback(
    (msg: Message): Message => {
      if (!msg.encrypted) return msg;
      const parsed = isEncryptedContent(msg.content);
      if (!parsed) return msg;
      const secKey = getSecretKey();
      if (!secKey) return { ...msg, content: '[Encrypted - no key available]' };
      const activeDM = dmChannels.find((d) => d.id === msg.channel_id);
      const otherPubKey = activeDM?.other_public_key;
      if (!otherPubKey) return { ...msg, content: '[Encrypted - missing sender key]' };
      try {
        const decrypted = decryptDM(parsed, otherPubKey, secKey);
        return { ...msg, content: decrypted };
      } catch {
        return { ...msg, content: '[Encrypted - unable to decrypt]' };
      }
    },
    [dmChannels],
  );

  const tryDecryptGroupDM = useCallback(
    (msg: Message): Message => {
      if (!msg.encrypted) return msg;
      const parsed = isGroupEncryptedContent(msg.content);
      if (!parsed) return msg;
      const secKey = getSecretKey();
      if (!secKey) return { ...msg, content: '[Encrypted - no key available]' };
      const currentUserId = session?.user.id;
      if (!currentUserId) return { ...msg, content: '[Encrypted - not authenticated]' };
      const channel = groupDMChannels.find((d) => d.id === msg.channel_id);
      const senderMember = channel?.members.find((m) => m.user_id === msg.user_id);
      const senderPubKey =
        senderMember?.public_key ||
        (msg as unknown as { sender_public_key?: string }).sender_public_key;
      if (!senderPubKey) return { ...msg, content: '[Encrypted - missing sender key]' };
      try {
        const decrypted = decryptGroupDM(parsed, senderPubKey, currentUserId, secKey);
        if (decrypted === null) return { ...msg, content: '[Encrypted - not a recipient]' };
        return { ...msg, content: decrypted };
      } catch {
        return { ...msg, content: '[Encrypted - unable to decrypt]' };
      }
    },
    [groupDMChannels, session],
  );

  const resolveRecipientPublicKey = useCallback(
    async (dm: DMChannelData | undefined): Promise<string | null> => {
      if (!dm || !session) return null;
      try {
        const freshKey = await getUserPublicKey(session.url, dm.other_user_id);
        if (freshKey) return freshKey;
      } catch (err) {
        console.error('Failed to get user public key, falling back to cached:', err);
      }
      return dm.other_public_key ?? null;
    },
    [session],
  );

  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);

  const canDeleteAny =
    activeChannelId && session
      ? hasDeletePermission(members, session.user.id, session.user.role)
      : false;
  const canCall =
    session?.user.permissions?.initiate_dm_calls === true || session?.user.role === 'admin';

  const MENTION_LIMIT = 8;

  const specialTargets = ['everyone', 'here'];
  const allSuggestions = [
    ...specialTargets,
    ...mentionableRoles.map((r) => r.name),
    ...members.map((m) => m.username),
  ];
  const suggestions =
    atQuery !== null
      ? allSuggestions.filter((u) => u.toLowerCase().startsWith(atQuery.toLowerCase()))
      : [];
  const emojiSuggestions =
    emojiQuery !== null
      ? EMOJI_LIST.filter((e) =>
          e.shortcode.toLowerCase().startsWith(emojiQuery.toLowerCase()),
        ).slice(0, 8)
      : [];

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

  useEffect(() => {
    setSelectedIndex(0);
  }, [suggestions.length, atQuery]);
  useEffect(() => {
    setSelectedEmojiIndex(0);
  }, [emojiSuggestions.length, emojiQuery]);
  useEffect(() => {
    suggestionRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (activeChannelId) {
      let cancelled = false;
      setLoading(true);
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
  }, [activeChannelId]);

  useEffect(() => {
    if (activeDMChannelId) {
      let cancelled = false;
      setLoading(true);
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
  }, [activeDMChannelId, tryDecryptDM]);

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
  }, [activeGroupDMChannelId, tryDecryptGroupDM]);

  // Draft persistence: save when leaving a channel, restore when entering
  useEffect(() => {
    const currentKey = activeChannelId || activeDMChannelId || activeGroupDMChannelId || null;
    const prevKey = prevChannelKeyRef.current;
    if (prevKey !== currentKey) {
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

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    };
  }, [pendingPreviewUrl]);

  const loadMoreMessages = useCallback(() => {
    const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
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
        const { messages: olderMsgs, hasMore } = activeDMChannelId
          ? await fetchDMMessages(session.url, channelId, 50, oldestId)
          : activeGroupDMChannelId
            ? await fetchGroupDMMessages(session.url, channelId, 50, oldestId)
            : await fetchMessages(session.url, channelId, 50, oldestId);
        if (olderMsgs.length === 0) {
          store.setHasMoreMessages(channelId, false);
          return;
        }
        const beforeLen = (store.messages[channelId] || []).length;
        const decrypted = activeDMChannelId
          ? olderMsgs.map((m) => tryDecryptDM(m))
          : activeGroupDMChannelId
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
    const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
    if (!channelId) return;
    const store = useChatStore.getState();
    store.setHasMoreMessages(channelId, true);
    store.setLoadMoreError(channelId, null);
    loadMoreMessages();
  }, [activeChannelId, activeDMChannelId, activeGroupDMChannelId, loadMoreMessages]);

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
      const query = getAtQuery(val, cursor);
      const emQuery = getEmojiQuery(val, cursor);
      setAtQuery(query);
      setEmojiQuery(emQuery);

      const slash =
        (activeChannelId || activeDMChannelId || activeGroupDMChannelId) &&
        val.startsWith('/') &&
        !val.slice(1).includes(' ')
          ? val.slice(1)
          : null;
      setSlashQuery(slash);
      if (slash !== null) setSelectedSlashIndex(0);
      if (query !== null) {
        const before = val.slice(0, cursor);
        setAtIndex(before.lastIndexOf('@'));
      }
      if (emQuery !== null) {
        const before = val.slice(0, cursor);
        setEmojiIndex(before.lastIndexOf(':'));
      }

      const el = inputRef.current;
      if (el) {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
      }

      const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
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
    [sendError, activeChannelId, activeDMChannelId, session],
  );

  const insertMention = (username: string) => {
    const before = input.slice(0, atIndex);
    const after = input.slice(atIndex + 1 + (atQuery?.length ?? 0));
    const newVal = `${before}@${username} ${after}`;
    setInput(newVal);
    setAtQuery(null);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + username.length + 2;
        inputRef.current.setSelectionRange(pos, pos);
        inputRef.current.focus();
      }
    });
  };

  useEffect(() => {
    if (pendingMention) {
      insertMention(pendingMention);
      setPendingMention(null);
    }
  }, [pendingMention]);

  const slashSuggestions = useMemo<ChatCommand[]>(() => {
    if (slashQuery === null || !session) return [];
    const q = slashQuery.toLowerCase();
    return CHAT_COMMANDS.filter(
      (c) =>
        (c.name.startsWith(q) || c.aliases?.some((a) => a.startsWith(q))) &&
        userCanUseCommand(session.user, c),
    );
  }, [slashQuery, session]);

  const insertSlashCommand = (cmd: ChatCommand) => {
    setInput(`/${cmd.name} `);
    setSlashQuery(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const insertEmoji = (entry: (typeof EMOJI_LIST)[0]) => {
    const before = input.slice(0, emojiIndex);
    const after = input.slice(emojiIndex + 1 + (emojiQuery?.length ?? 0));
    const newVal = `${before}${entry.emoji} ${after}`;
    setInput(newVal);
    setEmojiQuery(null);
    requestAnimationFrame(() => {
      if (inputRef.current) {
        const pos = before.length + entry.emoji.length + 1;
        inputRef.current.setSelectionRange(pos, pos);
        inputRef.current.focus();
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSlashIndex((i) => (i + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSlashIndex((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSlashCommand(slashSuggestions[selectedSlashIndex] ?? slashSuggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
    if (emojiSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedEmojiIndex((i) => (i + 1) % emojiSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedEmojiIndex((i) => (i - 1 + emojiSuggestions.length) % emojiSuggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertEmoji(emojiSuggestions[selectedEmojiIndex] ?? emojiSuggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setEmojiQuery(null);
        return;
      }
    }
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % suggestions.slice(0, MENTION_LIMIT).length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(
          (i) =>
            (i - 1 + suggestions.slice(0, MENTION_LIMIT).length) %
            suggestions.slice(0, MENTION_LIMIT).length,
        );
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertMention(suggestions[selectedIndex] ?? suggestions[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtQuery(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const applyFormat = (prefix: string, suffix = prefix) => {
    const ta = inputRef.current;
    if (!ta || !formatSel) return;
    const { start, end } = formatSel;
    const newValue =
      input.slice(0, start) + prefix + input.slice(start, end) + suffix + input.slice(end);
    setInput(newValue);
    setFormatSel(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = start + prefix.length;
      ta.selectionEnd = end + prefix.length;
    });
  };

  const handleSend = async () => {
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
        setAtQuery(null);
        setEmojiQuery(null);
        if (inputRef.current) inputRef.current.style.height = 'auto';
        return;
      }
      if (result.kind === 'compose') {
        commandContent = result.content;
      }

      // /poll is handled here because it needs channelId from component scope
      const trimmedInput = input.trim();
      if (trimmedInput.startsWith('/poll ') && activeChannelId) {
        const pollArgs = trimmedInput.slice(6);
        const parts = parsePollArgs(pollArgs);
        if (parts.length < 3) {
          setSendError('Usage: /poll "question" option1 option2 [option3 ...]');
          return;
        }
        const [question, ...options] = parts;
        try {
          await createPoll(session.url, activeChannelId, question, options);
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

    const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
    if (!channelId) return;

    socketRef.current?.emit('typing:stop', { channelId });

    const wasAtBottom = atBottom;

    try {
      let message: Message;
      if (activeChannelId) {
        const attIds = pendingAttachmentId ? [pendingAttachmentId] : undefined;
        message = await sendMessage(
          session.url,
          activeChannelId,
          commandContent ?? input.trim(),
          attIds,
          replyTo?.messageId,
        );
        setPendingAttachmentId(null);
      } else if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);
        const otherPubKey = await resolveRecipientPublicKey(activeDM);
        const secKey = getSecretKey();
        let content: string;
        let encrypted = false;
        if (otherPubKey && secKey) {
          const enc = encryptDM(commandContent ?? input.trim(), otherPubKey, secKey);
          content = JSON.stringify(enc);
          encrypted = true;
        } else {
          content = commandContent ?? input.trim();
        }
        message = await sendDMMessage(session.url, activeDMChannelId, content, encrypted);
        if (encrypted) {
          message = { ...message, content: commandContent ?? input.trim() };
        }
      } else if (activeGroupDMChannelId) {
        const secKey = getSecretKey();
        let content: string;
        let encrypted = false;
        if (secKey) {
          const channel = groupDMChannels.find((c) => c.id === activeGroupDMChannelId);
          const memberKeys = new Map<string, string>();
          for (const member of channel?.members || []) {
            if (member.public_key) memberKeys.set(member.user_id, member.public_key);
          }
          if (memberKeys.size > 0) {
            const enc = encryptGroupDM(commandContent ?? input.trim(), memberKeys, secKey);
            content = JSON.stringify(enc);
            encrypted = true;
          } else {
            content = commandContent ?? input.trim();
          }
        } else {
          content = commandContent ?? input.trim();
        }
        message = await sendGroupDMMessage(session.url, activeGroupDMChannelId, content, encrypted);
        if (encrypted) {
          message = { ...message, content: commandContent ?? input.trim() };
        }
      } else {
        return;
      }
      addMessage(message.channel_id || channelId, message);
      setInput('');
      setSlashQuery(null);
      setReplyTo(null);
      setSendError(null);
      haptics.tap();
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.focus();
      }
      if (!wasAtBottom) {
        requestAnimationFrame(() => {
          const chId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
          if (chId) {
            const msgs = useChatStore.getState().messages[chId] || [];
            if (msgs.length > 0) {
              virtuosoRef.current?.scrollToIndex(msgs.length - 1);
            }
            lastCountAtBottom.current = msgs.length;
          }
        });
      }
    } catch (err: unknown) {
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
    const isImage = file.type.startsWith('image/');
    setPendingPreviewUrl(isImage ? URL.createObjectURL(file) : null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!pendingFile || !session) return;

    const targetChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
    if (!targetChannelId) return;

    setUploading(true);
    setUploadProgress(0);

    const wasAtBottom = atBottom;

    try {
      const result = await uploadAttachment(session.url, targetChannelId, pendingFile, (pct) =>
        setUploadProgress(pct),
      );
      setPendingAttachmentId(result.id);
      const attachmentText = `![${result.filename}](${result.url})`;
      const text = input.trim();
      const attIds = [result.id];

      let message: Message;
      if (activeChannelId) {
        message = await sendMessage(
          session.url,
          activeChannelId,
          text ? text + '\n' + attachmentText : attachmentText,
          attIds,
        );
      } else if (activeDMChannelId) {
        const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);
        const otherPubKey = await resolveRecipientPublicKey(activeDM);
        const secKey = getSecretKey();
        const finalText = text ? text + '\n' + attachmentText : attachmentText;
        let content: string;
        let encrypted = false;
        if (otherPubKey && secKey) {
          const enc = encryptDM(finalText, otherPubKey, secKey);
          content = JSON.stringify(enc);
          encrypted = true;
        } else {
          content = finalText;
        }
        message = await sendDMMessage(session.url, activeDMChannelId, content, encrypted, attIds);
        if (encrypted) {
          message = { ...message, content: finalText };
        }
      } else if (activeGroupDMChannelId) {
        const secKey = getSecretKey();
        const finalText = text ? text + '\n' + attachmentText : attachmentText;
        let content: string;
        let encrypted = false;
        if (secKey) {
          const channel = groupDMChannels.find((c) => c.id === activeGroupDMChannelId);
          const memberKeys = new Map<string, string>();
          for (const member of channel?.members || []) {
            if (member.public_key) memberKeys.set(member.user_id, member.public_key);
          }
          if (memberKeys.size > 0) {
            const enc = encryptGroupDM(finalText, memberKeys, secKey);
            content = JSON.stringify(enc);
            encrypted = true;
          } else {
            content = finalText;
          }
        } else {
          content = finalText;
        }
        message = await sendGroupDMMessage(session.url, activeGroupDMChannelId, content, encrypted, attIds);
        if (encrypted) {
          message = { ...message, content: finalText };
        }
      } else {
        return;
      }
      addMessage(message.channel_id || targetChannelId, message);
      setInput('');
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      setPendingFile(null);
      setPendingPreviewUrl(null);
      setPendingAttachmentId(null);
      setSendError(null);
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.focus();
      }
      if (!wasAtBottom) {
        requestAnimationFrame(() => {
          const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
          if (channelId) {
            const msgs = useChatStore.getState().messages[channelId] || [];
            if (msgs.length > 0) {
              virtuosoRef.current?.scrollToIndex(msgs.length - 1);
            }
            lastCountAtBottom.current = msgs.length;
          }
        });
      }
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } }; message?: string };
      setSendError(e?.response?.data?.error || e?.message || 'Failed to upload file');
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      setPendingPreviewUrl(null);
      setPendingAttachmentId(null);
    }
    setUploading(false);
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
    setBulkDeleting(true);
    try {
      for (const id of selectedMessages) {
        await deleteMessage(session.url, id);
      }
      setSelectedMessages(new Set());
    } catch (err) {
      console.error('Bulk delete failed:', err);
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

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mr;
      recordingChunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordingChunksRef.current, { type: mr.mimeType });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: mr.mimeType });
        setPendingFile(file);
        setPendingPreviewUrl(null);
        setUploading(true);
        setUploadProgress(0);

        const targetChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
        if (!targetChannelId) return;

        try {
          const result = await uploadAttachment(session!.url, targetChannelId, file, (pct) =>
            setUploadProgress(pct),
          );
          const msgText = input.trim();
          const attachmentText = msgText ? `${msgText}\n![voice-message.webm](${result.url})` : `![voice-message.webm](${result.url})`;

          const attIds = [result.id];
          let message: Message;
          if (activeChannelId) {
            message = await sendMessage(session!.url, activeChannelId, attachmentText, attIds);
          } else if (activeDMChannelId) {
            const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);
            const otherPubKey = await resolveRecipientPublicKey(activeDM);
            const secKey = getSecretKey();
            let content: string;
            let enc = false;
            if (otherPubKey && secKey) {
              const encrypted = encryptDM(attachmentText, otherPubKey, secKey);
              content = JSON.stringify(encrypted);
              enc = true;
            } else {
              content = attachmentText;
            }
            message = await sendDMMessage(session!.url, activeDMChannelId!, content, enc, attIds);
            if (enc) {
              message = { ...message, content: attachmentText };
            }
          } else if (activeGroupDMChannelId) {
            const secKey = getSecretKey();
            let content: string;
            let encrypted = false;
            if (secKey) {
              const channel = groupDMChannels.find((c) => c.id === activeGroupDMChannelId);
              const memberKeys = new Map<string, string>();
              for (const member of channel?.members || []) {
                if (member.public_key) memberKeys.set(member.user_id, member.public_key);
              }
              if (memberKeys.size > 0) {
                const enc = encryptGroupDM(attachmentText, memberKeys, secKey);
                content = JSON.stringify(enc);
                encrypted = true;
              } else {
                content = attachmentText;
              }
            } else {
              content = attachmentText;
            }
            message = await sendGroupDMMessage(session!.url, activeGroupDMChannelId!, content, encrypted, attIds);
            if (encrypted) {
              message = { ...message, content: attachmentText };
            }
          }
          addMessage(targetChannelId, message!);
          setInput('');
        } catch (err) {
          console.error('Failed to send voice message:', err);
        }
        setUploading(false);
        setPendingFile(null);
      };

      mr.start();
      setRecording(true);
      setRecordingTime(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1);
      }, 1000);
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, [
    session,
    activeChannelId,
    activeDMChannelId,
    activeGroupDMChannelId,
    input,
    dmChannels,
    groupDMChannels,
    resolveRecipientPublicKey,
    addMessage,
  ]);

  const stopRecording = useCallback((send: boolean) => {
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      if (send) {
        mediaRecorderRef.current.stop();
      } else {
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      }
    }
    setRecording(false);
    setRecordingTime(0);
  }, []);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setPendingFile(files[0]);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      const isImage = files[0].type.startsWith('image/');
      setPendingPreviewUrl(isImage ? URL.createObjectURL(files[0]) : null);
    }
  };

  const handleEditMessage = useCallback(
    async (messageId: string, content: string) => {
      if (!session) return;
      const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;
      if (!channelId) return;
      try {
        if (activeDMChannelId) {
          const activeDM = dmChannels.find((d) => d.id === activeDMChannelId);
          if (!activeDM) return;
          const otherPubKey = await resolveRecipientPublicKey(activeDM);
          const secKey = getSecretKey();
          let sendContent = content;
          let encrypted = false;
          if (otherPubKey && secKey) {
            const enc = encryptDM(content, otherPubKey, secKey);
            sendContent = JSON.stringify(enc);
            encrypted = true;
          }
          await editDMMessage(session.url, messageId, sendContent, encrypted);
        } else if (activeGroupDMChannelId) {
          const secKey = getSecretKey();
          let sendContent = content;
          let encrypted = false;
          if (secKey) {
            const channel = groupDMChannels.find((c) => c.id === activeGroupDMChannelId);
            const memberKeys = new Map<string, string>();
            for (const member of channel?.members || []) {
              if (member.public_key) memberKeys.set(member.user_id, member.public_key);
            }
            if (memberKeys.size > 0) {
              const enc = encryptGroupDM(content, memberKeys, secKey);
              sendContent = JSON.stringify(enc);
              encrypted = true;
            }
          }
          await editGroupDMMessage(session.url, messageId, sendContent, encrypted);
        } else {
          await editMessage(session.url, messageId, content);
        }
      } catch (err) {
        console.error('Failed to edit message:', err);
      }
    },
    [
      session,
      activeChannelId,
      activeDMChannelId,
      activeGroupDMChannelId,
      dmChannels,
      groupDMChannels,
      resolveRecipientPublicKey,
    ],
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
  const channelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId || '';
  const typingList = typingUsers[channelId]?.filter((u) => u !== session?.user.username) || [];
  const typingText =
    typingList.length === 1
      ? `${typingList[0]} is typing...`
      : typingList.length > 1
        ? `${typingList.length} people are typing...`
        : '';
  const dmHasKey = activeDMChannelId ? !!(activeDM?.other_public_key && getSecretKey()) : false;
  const inputMaxLen = activeDMChannelId ? 2700 : 4000;
  const inputRemaining = inputMaxLen - input.length;
  const showCharCounter = inputRemaining < 500;
  const cantWrite = channelPerms?.locked && !channelPerms?.can_write;

  const handleJumpToMessage = useCallback(
    (messageId: string, targetChannelId: string) => {
      setShowSearch(false);

      const currentChannelId = activeChannelId || activeDMChannelId || activeGroupDMChannelId;

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
        const idx = displayMessages.findIndex((m) => m.id === messageId);
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
      activeChannelId,
      activeDMChannelId,
      activeGroupDMChannelId,
      dmChannels,
      groupDMChannels,
      setActiveChannel,
      setActiveDMChannel,
      setActiveGroupDMChannel,
      displayMessages,
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
      ref={chatAreaRef}
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
        <span className="chat-area__header-prefix">{activeDMChannelId ? '@' : '#'}</span>
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
            {channelPerms.can_write
              ? 'Locked'
              : `Locked to ${channelPerms.write_role_name || 'a role'}`}
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
          {(activeChannelId || activeDMChannelId || activeGroupDMChannelId) && (
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
          {(activeChannelId || activeDMChannelId || activeGroupDMChannelId) && (
            <IconButton
              icon={<ImageIcon className="icon-sm" />}
              label="Media gallery"
              title="Media"
              active={mediaGalleryOpen}
              onClick={() => setMediaGalleryOpen(true)}
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

      {showSearch && (activeChannelId || activeDMChannelId || activeGroupDMChannelId) && (
        <SearchBar
          channelId={activeChannelId || activeDMChannelId || activeGroupDMChannelId || undefined}
          onClose={() => setShowSearch(false)}
          onJumpToMessage={handleJumpToMessage}
        />
      )}

      <div className="chat-area__messages-wrap">
        <div className="chat-area__messages" role="log" aria-label="Messages" aria-live="polite">
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
          {!loading && displayMessages.length === 0 && (
            <p className="chat-area__loading">No messages yet. Be the first to send one!</p>
          )}
          {!loading && displayMessages.length > 0 && (
            <Virtuoso
              key={activeChannelId || activeDMChannelId}
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
                  const chId = activeChannelId || activeDMChannelId || '';
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
        {slashSuggestions.length > 0 && (
          <div className="chat-area__mention-suggestions chat-area__slash-suggestions">
            {slashSuggestions.map((cmd, i) => (
              <button
                key={cmd.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSlashCommand(cmd);
                }}
                onMouseEnter={() => setSelectedSlashIndex(i)}
                className={`chat-area__mention-suggestion ${i === selectedSlashIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
              >
                <span className="chat-area__mention-prefix">/</span>
                <span className="chat-area__slash-name">{cmd.name}</span>
                {cmd.usage && <span className="chat-area__slash-usage">{cmd.usage}</span>}
                <span className="chat-area__slash-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="chat-area__mention-suggestions">
            {suggestions.slice(0, MENTION_LIMIT).map((u, i) => {
              const mentionableRole = mentionableRoles.find((r) => r.name === u);
              const isRole = !!mentionableRole;
              return (
                <button
                  key={u}
                  ref={(el) => {
                    suggestionRefs.current[i] = el;
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertMention(u);
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={`chat-area__mention-suggestion ${i === selectedIndex ? 'chat-area__mention-suggestion--selected' : ''}`}
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
            {suggestions.length > MENTION_LIMIT && (
              <div className="chat-area__mention-capped">
                Found {suggestions.length} — keep typing to narrow
              </div>
            )}
          </div>
        )}

        {emojiSuggestions.length > 0 && (
          <div className="chat-area__emoji-suggestions">
            {emojiSuggestions.map((entry, i) => (
              <button
                key={entry.shortcode}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertEmoji(entry);
                }}
                onMouseEnter={() => setSelectedEmojiIndex(i)}
                className={`chat-area__emoji-suggestion ${i === selectedEmojiIndex ? 'chat-area__emoji-suggestion--selected' : ''}`}
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
              x
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
              <span className="chat-area__upload-progress">
                {uploadProgress > 0 && uploadProgress < 100 ? `${uploadProgress}%` : 'uploading...'}
              </span>
            ) : (
              <button
                className="chat-area__upload-cancel"
                onClick={() => {
                  if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
                  setPendingFile(null);
                  setPendingPreviewUrl(null);
                  setPendingAttachmentId(null);
                }}
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
                onClick={() => (recording ? undefined : startRecording())}
                title={recording ? 'Recording...' : 'Record voice message'}
                aria-label="Record voice message"
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
          {formatSel && (
            <div className="chat-area__format-toolbar" onMouseDown={(e) => e.preventDefault()}>
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
          <textarea
            ref={inputRef}
            className={`chat-area__input ${cantWrite ? 'chat-area__input--locked' : ''}`}
            rows={1}
            style={{ resize: 'none' }}
            placeholder={
              cantWrite
                ? `Channel locked — you cannot send messages`
                : `Message ${activeDMChannelId ? `@${activeDM?.other_display_name}` : `#${activeChannel?.name}`}`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onSelect={() => {
              const ta = inputRef.current;
              if (!ta) return;
              const { selectionStart, selectionEnd } = ta;
              if (
                selectionStart !== null &&
                selectionEnd !== null &&
                selectionStart !== selectionEnd
              ) {
                setFormatSel({ start: selectionStart, end: selectionEnd });
              } else {
                setFormatSel(null);
              }
            }}
            onBlur={() => setFormatSel(null)}
            maxLength={inputMaxLen}
            disabled={cantWrite}
            aria-label={`Message ${activeDMChannelId ? activeDM?.other_display_name || 'direct messages' : activeChannel?.name || 'channel'}`}
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
