import { client } from './core'

export async function createPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/channels/${channelId}/polls`, { question, options })
  return res.data
}

export async function createDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/dms/channel/${channelId}/polls`, { question, options })
  return res.data
}

export async function createGroupDMPoll(
  serverUrl: string,
  channelId: string,
  question: string,
  options: string[],
): Promise<{ poll: { id: string; question: string; options: { id: string; label: string; position: number }[] } }> {
  const res = await client(serverUrl).post(`/api/group-dms/${channelId}/polls`, { question, options })
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
