import {
  deriveKeyPair,
} from '@kizuna/shared/crypto'
import { uploadPublicKey } from '@kizuna/shared'

interface KeyState {
  publicKey: string | null
  secretKey: Uint8Array | null
  initialized: boolean
}

const LS_PREFIX = 'kizuna-crypto-'
const SS_KEY_PREFIX = 'kizuna-secret-key-'

const state: KeyState = {
  publicKey: null,
  secretKey: null,
  initialized: false,
}

function encodeSecretKey(sk: Uint8Array): string {
  return btoa(String.fromCharCode(...sk))
}

function decodeSecretKey(encoded: string): Uint8Array {
  return new Uint8Array(atob(encoded).split('').map(c => c.charCodeAt(0)))
}

export function getPublicKey(): string | null {
  return state.publicKey
}

export function getSecretKey(): Uint8Array | null {
  return state.secretKey
}

export function isCryptoInitialized(): boolean {
  return state.initialized
}

export function hasStoredKey(serverUrl: string): boolean {
  return !!localStorage.getItem(`${LS_PREFIX}${serverUrl}`)
}

export function restoreFromSession(serverUrl: string): boolean {
  const encoded = localStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}`) || sessionStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}`)
  if (!encoded) return false
  try {
    state.secretKey = decodeSecretKey(encoded)
    state.publicKey = localStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}-pub`) || sessionStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}-pub`) || null
    state.initialized = true
    return true
  } catch {
    return false
  }
}

export async function generateAndStoreKey(
  serverUrl: string,
  password: string,
  existingSalt?: Uint8Array,
): Promise<{ publicKey: string; salt: Uint8Array }> {
  const salt = existingSalt || window.crypto.getRandomValues(new Uint8Array(16));
  const kp = await deriveKeyPair(password, salt)

  const encoded = encodeSecretKey(kp.secretKey)
  localStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}`, encoded)
  localStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}-pub`, kp.publicKeyString)

  localStorage.setItem(`${LS_PREFIX}${serverUrl}`, JSON.stringify({
    publicKey: kp.publicKeyString,
    salt: Array.from(salt),
  }))

  state.publicKey = kp.publicKeyString
  state.secretKey = kp.secretKey
  state.initialized = true

  return { publicKey: kp.publicKeyString, salt }
}

export async function initializeCrypto(
  serverUrl: string,
  password: string,
  serverSalt?: Uint8Array | null,
  serverPublicKey?: string | null,
): Promise<{ publicKey: string; salt: Uint8Array }> {
  if (serverSalt != null) {
    try {
      const kp = await deriveKeyPair(password, serverSalt)
      localStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}`, encodeSecretKey(kp.secretKey))
      localStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}-pub`, kp.publicKeyString)
      localStorage.setItem(`${LS_PREFIX}${serverUrl}`, JSON.stringify({
        publicKey: kp.publicKeyString,
        salt: Array.from(serverSalt),
      }))
      state.publicKey = kp.publicKeyString
      state.secretKey = kp.secretKey
      state.initialized = true
      if (serverPublicKey !== kp.publicKeyString) {
        try {
          await uploadPublicKey(serverUrl, kp.publicKeyString, serverSalt)
        } catch {
          console.warn('[Crypto] Failed to upload updated public key')
        }
      }
      return { publicKey: kp.publicKeyString, salt: serverSalt }
    } catch {
      console.warn('[Crypto] Failed to derive key from server salt, generating new key')
    }
  }

  console.warn('[Crypto] No server salt available, generating new key pair (old account)')
  return generateAndStoreKey(serverUrl, password)
}

export function userNeedsKeyUpload(userPublicKey: string | null | undefined, serverUrl: string): boolean {
  if (!userPublicKey) return true
  const storedKey = localStorage.getItem(`${LS_PREFIX}${serverUrl}`)
  if (!storedKey) return true
  try {
    const parsed: { publicKey: string } = JSON.parse(storedKey)
    return parsed.publicKey !== userPublicKey
  } catch {
    return true
  }
}

export function clearCryptoState(): void {
  state.publicKey = null
  state.secretKey = null
  state.initialized = false
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(LS_PREFIX) || key.startsWith(SS_KEY_PREFIX)) {
      localStorage.removeItem(key)
    }
  }
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith(SS_KEY_PREFIX)) sessionStorage.removeItem(key)
  }
}
