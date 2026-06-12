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
  const encoded = sessionStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}`)
  if (!encoded) return false
  try {
    state.secretKey = decodeSecretKey(encoded)
    state.publicKey = sessionStorage.getItem(`${SS_KEY_PREFIX}${serverUrl}-pub`) || null
    state.initialized = true
    return true
  } catch {
    return false
  }
}

export async function generateAndStoreKey(
  serverUrl: string,
  password: string,
  existingSalt?: number[],
): Promise<{ publicKey: string; salt: number[] }> {
  const salt = existingSalt || Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
  const kp = await deriveKeyPair(password, salt)

  const encoded = encodeSecretKey(kp.secretKey)
  sessionStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}`, encoded)
  sessionStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}-pub`, kp.publicKeyString)

  localStorage.setItem(`${LS_PREFIX}${serverUrl}`, JSON.stringify({
    publicKey: kp.publicKeyString,
    salt,
  }))

  state.publicKey = kp.publicKeyString
  state.secretKey = kp.secretKey
  state.initialized = true

  return { publicKey: kp.publicKeyString, salt }
}

export async function initializeCrypto(
  serverUrl: string,
  token: string,
  password: string,
  serverSalt?: number[] | null,
  serverPublicKey?: string | null,
): Promise<{ publicKey: string; salt: number[] }> {
  if (serverSalt != null) {
    try {
      const kp = await deriveKeyPair(password, serverSalt)
      sessionStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}`, encodeSecretKey(kp.secretKey))
      sessionStorage.setItem(`${SS_KEY_PREFIX}${serverUrl}-pub`, kp.publicKeyString)
      localStorage.setItem(`${LS_PREFIX}${serverUrl}`, JSON.stringify({
        publicKey: kp.publicKeyString,
        salt: serverSalt,
      }))
      state.publicKey = kp.publicKeyString
      state.secretKey = kp.secretKey
      state.initialized = true
      if (serverPublicKey !== kp.publicKeyString) {
        await uploadPublicKey(serverUrl, token, kp.publicKeyString, serverSalt)
      }
      return { publicKey: kp.publicKeyString, salt: serverSalt }
    } catch {
      // Fall through to generate new key
    }
  }

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
}
