import {
  generateKeyPair,
  encryptPrivateKey,
  decryptPrivateKey,
  deriveKey,
} from '@kizuna/shared/crypto'
import { uploadPublicKey } from '@kizuna/shared'

interface KeyState {
  publicKey: string | null
  secretKey: Uint8Array | null
  initialized: boolean
}

interface StoredKey {
  encryptedPrivateKey: string
  publicKey: string
  salt: number[]
}

const LS_PREFIX = 'kizuna-crypto-'

const state: KeyState = {
  publicKey: null,
  secretKey: null,
  initialized: false,
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

export async function generateAndStoreKey(
  serverUrl: string,
  password: string,
): Promise<string> {
  const kp = generateKeyPair()
  const salt = Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
  const passwordKey = await deriveKey(password, salt)
  const encryptedPrivateKey = encryptPrivateKey(kp.secretKey, passwordKey)

  localStorage.setItem(`${LS_PREFIX}${serverUrl}`, JSON.stringify({
    encryptedPrivateKey,
    publicKey: kp.publicKeyString,
    salt,
  }))

  state.publicKey = kp.publicKeyString
  state.secretKey = kp.secretKey
  state.initialized = true

  return kp.publicKeyString
}

export async function initializeCrypto(
  serverUrl: string,
  token: string,
  password: string,
): Promise<boolean> {
  const storageKey = `${LS_PREFIX}${serverUrl}`
  const existingKey = localStorage.getItem(storageKey)

  if (existingKey) {
    try {
      const stored: StoredKey = JSON.parse(existingKey)
      const passwordKey = await deriveKey(password, stored.salt)
      const secretKey = decryptPrivateKey(stored.encryptedPrivateKey, passwordKey)
      state.publicKey = stored.publicKey
      state.secretKey = secretKey
      state.initialized = true
      return true
    } catch {
      // Wrong password or corrupted data — fall through to generate new key
    }
  }

  const kp = generateKeyPair()
  const salt = Array.from(window.crypto.getRandomValues(new Uint8Array(16)))
  const passwordKey = await deriveKey(password, salt)
  const encryptedPrivateKey = encryptPrivateKey(kp.secretKey, passwordKey)

  localStorage.setItem(storageKey, JSON.stringify({
    encryptedPrivateKey,
    publicKey: kp.publicKeyString,
    salt,
  }))

  state.publicKey = kp.publicKeyString
  state.secretKey = kp.secretKey
  state.initialized = true

  await uploadPublicKey(serverUrl, token, kp.publicKeyString)
  return true
}

export function userNeedsKeyUpload(userPublicKey: string | null | undefined, serverUrl: string): boolean {
  if (!userPublicKey) return true
  const storedKey = localStorage.getItem(`${LS_PREFIX}${serverUrl}`)
  if (!storedKey) return true
  try {
    const parsed: StoredKey = JSON.parse(storedKey)
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
