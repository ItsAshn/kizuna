import type {
  LinkedIdentity,
} from '../types'
import { client } from './core'

// ─── Identity Linking ─────────────────────────────────────

export async function initiateIdentityLink(
  serverUrl: string,
): Promise<{ nonce: string; expiresAt: number }> {
  const res = await client(serverUrl).post('/api/auth/identity-link/initiate')
  return res.data
}

export async function confirmIdentityLink(
  serverUrl: string,
  requestingServer: string,
  nonce: string,
): Promise<{ verificationToken: string }> {
  const res = await client(serverUrl).post('/api/auth/identity-link/confirm', {
    requestingServer,
    nonce,
  })
  return res.data
}

export async function completeIdentityLink(
  serverUrl: string,
  linkedServerUrl: string,
  verificationToken: string,
): Promise<LinkedIdentity> {
  const res = await client(serverUrl).post('/api/auth/identity-link/complete', {
    linkedServerUrl,
    verificationToken,
  })
  return res.data.linked_identity
}

export async function getLinkedIdentities(
  serverUrl: string,
): Promise<LinkedIdentity[]> {
  const res = await client(serverUrl).get('/api/auth/identity-links')
  return res.data.linked_identities ?? []
}

export async function setLinkedIdentityPublic(
  serverUrl: string,
  linkId: string,
  isPublic: boolean,
): Promise<void> {
  await client(serverUrl).patch(`/api/auth/identity-links/${linkId}/public`, {
    public: isPublic,
  })
}

export async function unlinkIdentity(
  serverUrl: string,
  linkId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/auth/identity-links/${linkId}`)
}
