import { client } from './core'
import type { PollData } from '../types'

/** Optional poll settings: auto-close duration (seconds) and multi-select. */
export interface PollCreateOptions {
  durationSeconds?: number | null
  allowMultiple?: boolean
}

export async function createPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
  opts?: PollCreateOptions,
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/channels/${channelId}/polls`, { question, options, ...opts })
  return res.data
}

export async function createDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
  opts?: PollCreateOptions,
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/dms/channel/${channelId}/polls`, { question, options, ...opts })
  return res.data
}

export async function createGroupDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
  opts?: PollCreateOptions,
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/group-dms/${channelId}/polls`, { question, options, ...opts })
  return res.data
}

/** Fetch all polls in a channel (with vote counts and the current user's votes) for hydration. */
export async function fetchChannelPolls(
  serverUrl: string,
  channelId: string,
  channelType: 'channel' | 'dm' | 'group-dm',
): Promise<{ polls: (PollData & { userVoteIds: string[] })[] }> {
  const path =
    channelType === 'dm'
      ? `/api/dms/channel/${channelId}/polls`
      : channelType === 'group-dm'
        ? `/api/group-dms/${channelId}/polls`
        : `/api/channels/${channelId}/polls`
  const res = await client(serverUrl).get(path)
  return res.data
}

export async function fetchPoll(
  serverUrl: string,
  pollId: string,
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number; vote_count: number }[]; userVoteIds: string[] } }> {
  const res = await client(serverUrl).get(`/api/polls/${pollId}`)
  return res.data
}

export async function votePoll(
  serverUrl: string,
  pollId: string,
  optionId: string,
): Promise<{ options: { id: string; label: string; position: number; vote_count: number }[]; userVoteIds: string[] }> {
  const res = await client(serverUrl).post(`/api/polls/${pollId}/vote`, { optionId })
  return res.data
}

export async function deletePoll(
  serverUrl: string,
  pollId: string,
): Promise<void> {
  await client(serverUrl).delete(`/api/polls/${pollId}`)
}

// Webhooks
