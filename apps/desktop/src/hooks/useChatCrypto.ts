import { useCallback } from 'react';
import { getUserPublicKey } from '@kizuna/shared';
import {
  encryptDM,
  decryptDM,
  isEncryptedContent,
  encryptGroupDM,
  decryptGroupDM,
  isGroupEncryptedContent,
} from '@kizuna/shared/crypto';
import type { Message, DMChannelData } from '@kizuna/shared';
import { getSecretKey } from '../store/keyStore';
import { useChatStore } from '../store/chatStore';
import type { ServerSession } from '../store/serverStore';

// Encrypt/decrypt helpers for DM and group-DM channels. Falls back to
// plaintext (or an explanatory placeholder) when keys are unavailable.
export function useChatCrypto(session: ServerSession | null) {
  const activeDMChannelId = useChatStore((s) => s.activeDMChannelId);
  const activeGroupDMChannelId = useChatStore((s) => s.activeGroupDMChannelId);
  const dmChannels = useChatStore((s) => s.dmChannels);
  const groupDMChannels = useChatStore((s) => s.groupDMChannels);

  const tryDecryptDM = useCallback((msg: Message): Message => {
    if (!msg.encrypted) return msg;
    const parsed = isEncryptedContent(msg.content);
    if (!parsed) return msg;
    const secKey = getSecretKey();
    if (!secKey) return { ...msg, content: '[Encrypted - no key available]' };
    const activeDM = useChatStore.getState().dmChannels.find((d) => d.id === msg.channel_id);
    const otherPubKey = activeDM?.other_public_key;
    if (!otherPubKey) return { ...msg, content: '[Encrypted - missing sender key]' };
    try {
      const decrypted = decryptDM(parsed, otherPubKey, secKey);
      return { ...msg, content: decrypted };
    } catch {
      return { ...msg, content: '[Encrypted - unable to decrypt]' };
    }
  }, []);

  const tryDecryptGroupDM = useCallback(
    (msg: Message): Message => {
      if (!msg.encrypted) return msg;
      const parsed = isGroupEncryptedContent(msg.content);
      if (!parsed) return msg;
      const secKey = getSecretKey();
      if (!secKey) return { ...msg, content: '[Encrypted - no key available]' };
      const currentUserId = session?.user.id;
      if (!currentUserId) return { ...msg, content: '[Encrypted - not authenticated]' };
      const channel = useChatStore.getState().groupDMChannels.find((d) => d.id === msg.channel_id);
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
    [session],
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

  // Encrypts outgoing content for the active DM / group DM; plaintext fallback when keys are unavailable.
  const encryptOutgoing = useCallback(
    async (plain: string): Promise<{ content: string; encrypted: boolean }> => {
      const secKey = getSecretKey();
      if (activeDMChannelId && secKey) {
        const dm = dmChannels.find((d) => d.id === activeDMChannelId);
        const otherPubKey = await resolveRecipientPublicKey(dm);
        if (otherPubKey) {
          return {
            content: JSON.stringify(encryptDM(plain, otherPubKey, secKey)),
            encrypted: true,
          };
        }
      } else if (activeGroupDMChannelId && secKey) {
        const channel = groupDMChannels.find((c) => c.id === activeGroupDMChannelId);
        const memberKeys = new Map<string, string>();
        for (const member of channel?.members || []) {
          if (member.public_key) memberKeys.set(member.user_id, member.public_key);
        }
        if (memberKeys.size > 0) {
          return {
            content: JSON.stringify(encryptGroupDM(plain, memberKeys, secKey)),
            encrypted: true,
          };
        }
      }
      return { content: plain, encrypted: false };
    },
    [
      activeDMChannelId,
      activeGroupDMChannelId,
      dmChannels,
      groupDMChannels,
      resolveRecipientPublicKey,
    ],
  );

  return { tryDecryptDM, tryDecryptGroupDM, encryptOutgoing };
}
