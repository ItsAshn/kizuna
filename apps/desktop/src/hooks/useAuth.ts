import { useState } from 'react'
import { login, register, uploadPublicKey, getChallenge } from '@kizuna/shared'
import { solvePoW } from '@kizuna/shared/pow'
import { generateAndStoreKey, initializeCrypto, userNeedsKeyUpload } from '../store/keyStore'

interface AuthParams {
  username: string
  password: string
  isRegister: boolean
  displayName?: string
  serverPassword?: string
}

interface AuthResult {
  success: boolean
  result?: any
}

export function useAuth(serverUrl: string) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [backupToken, setBackupToken] = useState<string | null>(null)

  async function authenticate(params: AuthParams): Promise<AuthResult> {
    const { username, password, isRegister, displayName, serverPassword } = params
    if (!username.trim() || !password.trim()) {
      return { success: false }
    }

    setLoading(true)
    setError('')
    setBackupToken(null)

    try {
      if (isRegister) {
        const { challenge, difficulty } = await getChallenge(serverUrl)
        const { nonce } = await solvePoW(challenge, difficulty)
        const { publicKey, salt } = await generateAndStoreKey(serverUrl, password)
        const result = await register(
          serverUrl,
          username.trim(),
          password,
          displayName || username,
          serverPassword || undefined,
          publicKey,
          JSON.stringify(Array.from(salt)),
          challenge,
          nonce,
        )

        if (result.backuptoken) {
          setBackupToken(result.backuptoken)
        }

        setLoading(false)
        return { success: true, result }
      } else {
        const result = await login(serverUrl, username.trim(), password)

        const serverSalt = result.user.key_salt
          ? new Uint8Array(JSON.parse(result.user.key_salt))
          : null
        const { publicKey, salt } = await initializeCrypto(
          serverUrl,
          password,
          serverSalt,
          result.user.public_key,
        )
        if (userNeedsKeyUpload(result.user.public_key, serverUrl)) {
          try {
            await uploadPublicKey(serverUrl, publicKey, salt)
          } catch {
            console.warn('[Auth] Failed to upload public key after login')
          }
        }

        setLoading(false)
        return { success: true, result }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || err.message || 'Authentication failed')
      setLoading(false)
      return { success: false }
    }
  }

  function clearBackupToken() {
    setBackupToken(null)
  }

  return { authenticate, loading, error, setError, backupToken, clearBackupToken }
}
