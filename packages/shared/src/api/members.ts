import type {
  User,
  Member,
  CustomRole,
  Permission,
} from '../types'
import { client } from './core'

// ─── Members ──────────────────────────────────────────────

export async function fetchMembers(
  serverUrl: string,
): Promise<Member[]> {
  const res = await client(serverUrl).get('/api/auth/users')
  return res.data.users ?? res.data
}

export async function getUserProfile(
  serverUrl: string,
  userId: string,
): Promise<Member> {
  const res = await client(serverUrl).get(`/api/auth/users/${userId}`)
  return res.data
}

// ─── Profile ──────────────────────────────────────────────

export async function updateProfile(
  serverUrl: string,
  display_name?: string,
  avatar?: string | null,
  banner?: string | null,
): Promise<User> {
  const res = await client(serverUrl).patch('/api/auth/profile', {
    display_name,
    avatar,
    banner,
  })
  return res.data.user ?? res.data
}

// ─── Member Management ────────────────────────────────────

export async function setMemberRole(
  serverUrl: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await client(serverUrl).patch(`/api/server/members/${userId}/role`, { role })
}

export async function kickMember(
  serverUrl: string,
  userId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/server/members/${userId}`)
}

export async function addMemberRole(
  serverUrl: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await client(serverUrl).post(`/api/server/members/${userId}/roles`, { roleId })
}

export async function removeMemberRole(
  serverUrl: string,
  userId: string,
  roleId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/server/members/${userId}/roles/${roleId}`)
}

export async function banUser(
  serverUrl: string,
  userId: string,
  reason?: string,
): Promise<void> {
  await client(serverUrl).post(`/api/bans/${userId}`, { reason: reason ?? null })
}

export async function unbanUser(
  serverUrl: string,
  userId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/bans/${userId}`)
}

// ─── Roles ────────────────────────────────────────────────

export async function fetchRoles(
  serverUrl: string,
): Promise<CustomRole[]> {
  const res = await client(serverUrl).get('/api/roles')
  return res.data.roles ?? res.data
}

export async function createRole(
  serverUrl: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
  hoist?: boolean,
  mentionable?: boolean,
  defaultOnJoin?: boolean,
): Promise<CustomRole> {
  const res = await client(serverUrl).post('/api/roles', {
    name,
    color,
    permissions,
    hoist,
    mentionable,
    default_on_join: defaultOnJoin,
  })
  return res.data.role ?? res.data
}

export async function updateRole(
  serverUrl: string,
  id: string,
  name: string,
  color: string,
  permissions: Partial<Record<Permission, boolean>>,
  hoist?: boolean,
  mentionable?: boolean,
  defaultOnJoin?: boolean,
): Promise<CustomRole> {
  const res = await client(serverUrl).patch(`/api/roles/${id}`, {
    name,
    color,
    permissions,
    hoist,
    mentionable,
    default_on_join: defaultOnJoin,
  })
  return res.data.role ?? res.data
}

export async function deleteRole(
  serverUrl: string,
  id: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/roles/${id}`)
}

export async function reorderRoles(
  serverUrl: string,
  order: { id: string; position: number }[],
): Promise<void> {
  await client(serverUrl).patch('/api/roles/reorder', { order })
}

