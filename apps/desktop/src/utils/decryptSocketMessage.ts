import { useChatStore } from '../store/chatStore'
import { useServerStore } from '../store/serverStore'
import { decryptDM, isEncryptedContent, decryptGroupDM, isGroupEncryptedContent } from '@kizuna/shared/crypto'
import { getSecretKey } from '../store/keyStore'
import type { Message } from '@kizuna/shared'

export function tryDecryptSocketDM(message: Message): Message {
  if (!message.encrypted) return message
  const parsed = isEncryptedContent(message.content)
  if (!parsed) return message
  const secKey = getSecretKey()
  if (!secKey) return { ...message, content: '[Encrypted - no key available]' }
  const dm = useChatStore.getState().dmChannels.find((d) => d.id === message.channel_id)
  const otherPubKey = dm?.other_public_key
  if (!otherPubKey) return { ...message, content: '[Encrypted - missing sender key]' }
  try {
    const decrypted = decryptDM(parsed, otherPubKey, secKey)
    return { ...message, content: decrypted }
  } catch {
    return { ...message, content: '[Encrypted - unable to decrypt]' }
  }
}

export function tryDecryptGroupDM(message: Message): Message {
  if (!message.encrypted) return message
  const parsed = isGroupEncryptedContent(message.content)
  if (!parsed) return message
  const secKey = getSecretKey()
  if (!secKey) return { ...message, content: '[Encrypted - no key available]' }
  const currentUserId = useServerStore.getState().activeSession?.user.id
  if (!currentUserId) return { ...message, content: '[Encrypted - not authenticated]' }
  const channel = useChatStore.getState().groupDMChannels.find((d) => d.id === message.channel_id)
  const senderMember = channel?.members.find((m) => m.user_id === message.user_id)
  const senderPubKey = senderMember?.public_key || (message as unknown as { sender_public_key?: string }).sender_public_key
  if (!senderPubKey) return { ...message, content: '[Encrypted - missing sender key]' }
  try {
    const decrypted = decryptGroupDM(parsed, senderPubKey, currentUserId, secKey)
    if (decrypted === null) return { ...message, content: '[Encrypted - not a recipient]' }
    return { ...message, content: decrypted }
  } catch {
    return { ...message, content: '[Encrypted - unable to decrypt]' }
  }
}
