import nacl from 'tweetnacl'
import { encodeBase64, decodeBase64, decodeUTF8 } from 'tweetnacl-util'

export const KEY_VERSION = 1

export interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export interface EncryptedMessage {
  v: number
  ct: string
  n: string
}

let prngInitialized = false

function ensurePRNG(): void {
  if (prngInitialized) return
  const cryptoApi: { getRandomValues?: (array: Uint8Array) => Uint8Array } =
    (typeof globalThis !== 'undefined' && globalThis.crypto) ||
    (typeof window !== 'undefined' && window.crypto) ||
    {}
  if (cryptoApi.getRandomValues) {
    nacl.setPRNG((x, n) => {
      const bytes = new Uint8Array(n)
      cryptoApi.getRandomValues!(bytes)
      for (let i = 0; i < n; i++) x[i] = bytes[i]!
    })
  }
  prngInitialized = true
}

export async function deriveKeyPair(
  password: string,
  salt: Uint8Array,
): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array; publicKeyString: string }> {
  const seed = await deriveKey(password, salt)
  const kp = nacl.box.keyPair.fromSecretKey(seed)
  return {
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    publicKeyString: encodeBase64(kp.publicKey),
  }
}

export function encryptDM(
  plaintext: string,
  theirPublicKeyB64: string,
  mySecretKey: Uint8Array,
): EncryptedMessage {
  ensurePRNG()
  const theirPublicKey = decodeBase64(theirPublicKeyB64)
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const messageBytes = decodeUTF8(plaintext)
  const ciphertext = nacl.box(messageBytes, nonce, theirPublicKey, mySecretKey)
  if (!ciphertext) throw new Error('Encryption failed')
  return {
    v: KEY_VERSION,
    ct: encodeBase64(ciphertext),
    n: encodeBase64(nonce),
  }
}

export function decryptDM(
  encrypted: EncryptedMessage,
  theirPublicKeyB64: string,
  mySecretKey: Uint8Array,
): string {
  const theirPublicKey = decodeBase64(theirPublicKeyB64)
  const ciphertext = decodeBase64(encrypted.ct)
  const nonce = decodeBase64(encrypted.n)
  const decrypted = nacl.box.open(ciphertext, nonce, theirPublicKey, mySecretKey)
  if (!decrypted) throw new Error('Decryption failed')
  return encodeUTF8(decrypted)
}

export function isEncryptedContent(content: string): EncryptedMessage | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed.v === 'number' && typeof parsed.ct === 'string' && typeof parsed.n === 'string') {
      return parsed as EncryptedMessage
    }
  } catch {
    // not JSON, not encrypted
  }
  return null
}

export interface GroupEncryptedMessage {
  v: number
  recipients: Record<string, EncryptedMessage>
}

export function encryptGroupDM(
  plaintext: string,
  memberKeys: Map<string, string>,
  mySecretKey: Uint8Array,
): GroupEncryptedMessage {
  ensurePRNG()
  const recipients: Record<string, EncryptedMessage> = {}
  for (const [userId, publicKeyB64] of memberKeys) {
    recipients[userId] = encryptDM(plaintext, publicKeyB64, mySecretKey)
  }
  return { v: KEY_VERSION, recipients }
}

export function decryptGroupDM(
  encrypted: GroupEncryptedMessage,
  senderPublicKeyB64: string,
  myUserId: string,
  mySecretKey: Uint8Array,
): string | null {
  const myEntry = encrypted.recipients[myUserId]
  if (!myEntry) return null
  try {
    return decryptDM(myEntry, senderPublicKeyB64, mySecretKey)
  } catch {
    return null
  }
}

export function isGroupEncryptedContent(content: string): GroupEncryptedMessage | null {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed.v === 'number' && parsed.recipients && typeof parsed.recipients === 'object') {
      return parsed as GroupEncryptedMessage
    }
  } catch {
    // not JSON, not encrypted
  }
  return null
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: 600_000,
    },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}

function encodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
