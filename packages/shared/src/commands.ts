import type { Permission } from './types'

/**
 * Slash-command catalogue shared between client and (potential) server use.
 *
 * - `action`  — calls a server endpoint; result is shown ephemerally to the invoker.
 * - `compose` — rewritten into normal message content and sent like any message.
 * - `client`  — handled entirely on the client (e.g. `/help`).
 *
 * `permission` documents the privilege the command requires. Server endpoints remain
 * the real enforcement point; the client uses it to gate availability and autocomplete.
 */
export type ChatCommandKind = 'action' | 'compose' | 'client'

export interface ChatCommand {
  name: string
  aliases?: string[]
  kind: ChatCommandKind
  permission?: Permission
  /** Argument hint, e.g. "<user> [reason]". */
  usage?: string
  description: string
}

export const CHAT_COMMANDS: ChatCommand[] = [
  // ─── Moderation ───────────────────────────────────────────────
  { name: 'kick', kind: 'action', permission: 'kick_members', usage: '<user> [reason]', description: 'Remove a member from the server' },
  { name: 'ban', kind: 'action', permission: 'ban_members', usage: '<user> [reason]', description: 'Permanently ban a member' },
  { name: 'unban', kind: 'action', permission: 'ban_members', usage: '<user>', description: 'Lift a ban so the user can rejoin' },

  // ─── Roles & members ──────────────────────────────────────────
  { name: 'role', kind: 'action', permission: 'manage_roles', usage: 'add|remove <user> <role>', description: 'Grant or remove a role from a member' },
  { name: 'roles', kind: 'client', usage: '<user>', description: "List a member's roles" },
  { name: 'nick', kind: 'action', usage: '<nickname>', description: 'Change your own display name' },

  // ─── Utility / fun ────────────────────────────────────────────
  { name: 'help', kind: 'client', usage: '[command]', description: 'List available commands' },
  { name: 'me', kind: 'compose', permission: 'send_messages', usage: '<action>', description: 'Send an action/emote message' },
  { name: 'shrug', kind: 'compose', permission: 'send_messages', usage: '[message]', description: 'Append ¯\\_(ツ)_/¯' },
  { name: 'tableflip', kind: 'compose', permission: 'send_messages', description: 'Flip a table (╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', kind: 'compose', permission: 'send_messages', description: 'Restore the table ┬─┬ ノ( ゜-゜ノ)' },
  { name: 'spoiler', kind: 'compose', permission: 'send_messages', usage: '<message>', description: 'Mark a message as a spoiler' },
  { name: 'roll', kind: 'compose', permission: 'send_messages', usage: '[NdM]', description: 'Roll dice (default 1d20)' },
  { name: 'flip', kind: 'compose', permission: 'send_messages', description: 'Flip a coin' },
  { name: '8ball', kind: 'compose', permission: 'send_messages', usage: '<question>', description: 'Ask the magic 8-ball' },
]

export function findChatCommand(name: string): ChatCommand | undefined {
  const lower = name.toLowerCase()
  return CHAT_COMMANDS.find(
    (c) => c.name === lower || c.aliases?.includes(lower),
  )
}

export interface ParsedSlashCommand {
  name: string
  /** Everything after the command name, untrimmed of internal spacing. */
  argString: string
  /** Whitespace-split arguments. */
  args: string[]
}

/** Parse a raw input like "/ban alice spamming" into its command and arguments. */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (!input.startsWith('/')) return null
  const body = input.slice(1)
  const match = body.match(/^(\S+)\s*([\s\S]*)$/)
  if (!match) return null
  const name = match[1]!.toLowerCase()
  const argString = match[2] ?? ''
  const args = argString.length > 0 ? argString.split(/\s+/) : []
  return { name, argString, args }
}
