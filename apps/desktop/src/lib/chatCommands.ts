import {
  CHAT_COMMANDS,
  findChatCommand,
  parseSlashCommand,
  kickMember,
  banUser,
  unbanUser,
  addMemberRole,
  removeMemberRole,
  updateProfile,
  fetchRoles,
} from '@kizuna/shared'
import type { ChatCommand, Member, Permission } from '@kizuna/shared'

export interface CommandUser {
  id: string
  username: string
  role?: string
  permissions?: Partial<Record<Permission, boolean>>
}

export interface CommandContext {
  serverUrl: string
  user: CommandUser
  members: Member[]
  /** Show an ephemeral notice to the invoker only. */
  notify: (title: string, body: string) => void
}

export type CommandResult =
  | { kind: 'ignore' } // not a recognized command — send the text as a normal message
  | { kind: 'handled' } // fully handled; nothing should be sent
  | { kind: 'compose'; content: string } // send this content as a normal message

const EIGHT_BALL = [
  'It is certain.', 'Without a doubt.', 'Yes — definitely.', 'You may rely on it.',
  'Most likely.', 'Outlook good.', 'Signs point to yes.', 'Reply hazy, try again.',
  'Ask again later.', 'Cannot predict now.', "Don't count on it.", 'My reply is no.',
  'Outlook not so good.', 'Very doubtful.',
]

export function userCanUseCommand(user: CommandUser, command: ChatCommand): boolean {
  if (!command.permission) return true
  if (user.role === 'admin') return true
  return user.permissions?.[command.permission] === true
}

function resolveMember(members: Member[], name: string): Member | undefined {
  const n = name.replace(/^@/, '').toLowerCase()
  return (
    members.find((m) => m.username.toLowerCase() === n) ??
    members.find((m) => (m.display_name ?? '').toLowerCase() === n)
  )
}

function rollDice(spec: string | undefined): string {
  const m = (spec ?? '1d20').match(/^(\d*)d(\d+)$/i)
  const count = Math.min(Math.max(parseInt(m?.[1] || '1', 10) || 1, 1), 100)
  const sides = Math.min(Math.max(parseInt(m?.[2] || '20', 10) || 20, 2), 1000)
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
  const total = rolls.reduce((a, b) => a + b, 0)
  const detail = count > 1 ? ` (${rolls.join(' + ')})` : ''
  return `🎲 Rolled ${count}d${sides} → **${total}**${detail}`
}

function helpText(forCommand?: ChatCommand, user?: CommandUser): string {
  if (forCommand) {
    return `/${forCommand.name} ${forCommand.usage ?? ''}`.trim() + ` — ${forCommand.description}`
  }
  const usable = CHAT_COMMANDS.filter((c) => !user || userCanUseCommand(user, c))
  return usable.map((c) => `/${c.name}${c.usage ? ' ' + c.usage : ''}`).join('\n')
}

/**
 * Parse and run a slash command. Action commands hit the server and report results
 * ephemerally; compose commands return transformed message content to send normally.
 * Returns `{ kind: 'ignore' }` for any input that isn't a recognized command.
 */
export async function runChatCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseSlashCommand(input)
  if (!parsed) return { kind: 'ignore' }

  const command = findChatCommand(parsed.name)
  if (!command) return { kind: 'ignore' }

  const { args, argString } = parsed

  // Permission gate (server still enforces; this is for fast, clear feedback).
  if (!userCanUseCommand(ctx.user, command)) {
    ctx.notify('Permission denied', `You don't have permission to use /${command.name}.`)
    return { kind: 'handled' }
  }

  // ─── Compose commands: transform into a normal message ──────────
  if (command.kind === 'compose') {
    switch (command.name) {
      case 'me':
        if (!argString.trim()) { ctx.notify('Usage', '/me <action>'); return { kind: 'handled' } }
        return { kind: 'compose', content: `*${argString.trim()}*` }
      case 'shrug':
        return { kind: 'compose', content: `${argString.trim()} ¯\\_(ツ)_/¯`.trim() }
      case 'tableflip':
        return { kind: 'compose', content: '(╯°□°)╯︵ ┻━┻' }
      case 'unflip':
        return { kind: 'compose', content: '┬─┬ ノ( ゜-゜ノ)' }
      case 'spoiler':
        if (!argString.trim()) { ctx.notify('Usage', '/spoiler <message>'); return { kind: 'handled' } }
        return { kind: 'compose', content: `||${argString.trim()}||` }
      case 'roll':
        return { kind: 'compose', content: rollDice(args[0]) }
      case 'flip':
        return { kind: 'compose', content: `🪙 ${Math.random() < 0.5 ? 'Heads' : 'Tails'}` }
      case '8ball':
        if (!argString.trim()) { ctx.notify('Usage', '/8ball <question>'); return { kind: 'handled' } }
        return { kind: 'compose', content: `🎱 ${EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)]}` }
    }
  }

  // ─── Client-only commands ───────────────────────────────────────
  if (command.name === 'help') {
    const target = args[0] ? findChatCommand(args[0].replace(/^\//, '')) : undefined
    ctx.notify(target ? `/${target.name}` : 'Commands', helpText(target, ctx.user))
    return { kind: 'handled' }
  }

  if (command.name === 'roles') {
    const target = resolveMember(ctx.members, args[0] ?? '')
    if (!target) { ctx.notify('User not found', `No member matching "${args[0] ?? ''}".`); return { kind: 'handled' } }
    const roleNames = (target.custom_roles ?? []).map((r) => r.name).join(', ') || 'No roles'
    ctx.notify(`@${target.username}`, roleNames)
    return { kind: 'handled' }
  }

  // ─── Action commands: hit the server ────────────────────────────
  try {
    switch (command.name) {
      case 'kick': {
        const target = resolveMember(ctx.members, args[0] ?? '')
        if (!target) return notFound(ctx, args[0])
        await kickMember(ctx.serverUrl, target.id)
        ctx.notify('Member kicked', `@${target.username} was removed from the server.`)
        return { kind: 'handled' }
      }
      case 'ban': {
        const target = resolveMember(ctx.members, args[0] ?? '')
        if (!target) return notFound(ctx, args[0])
        const reason = args.slice(1).join(' ') || undefined
        await banUser(ctx.serverUrl, target.id, reason)
        ctx.notify('Member banned', `@${target.username} was banned${reason ? `: ${reason}` : '.'}`)
        return { kind: 'handled' }
      }
      case 'unban': {
        // The user may already be gone from the member list; resolve by username if present.
        const target = resolveMember(ctx.members, args[0] ?? '')
        if (!target) return notFound(ctx, args[0])
        await unbanUser(ctx.serverUrl, target.id)
        ctx.notify('Ban lifted', `@${target.username} can rejoin the server.`)
        return { kind: 'handled' }
      }
      case 'role': {
        const sub = (args[0] ?? '').toLowerCase()
        if (sub !== 'add' && sub !== 'remove') {
          ctx.notify('Usage', '/role add|remove <user> <role>')
          return { kind: 'handled' }
        }
        const target = resolveMember(ctx.members, args[1] ?? '')
        if (!target) return notFound(ctx, args[1])
        const roleName = args.slice(2).join(' ').trim()
        if (!roleName) { ctx.notify('Usage', '/role add|remove <user> <role>'); return { kind: 'handled' } }
        const roles = await fetchRoles(ctx.serverUrl)
        const role = roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase())
        if (!role) { ctx.notify('Role not found', `No role named "${roleName}".`); return { kind: 'handled' } }
        if (sub === 'add') {
          await addMemberRole(ctx.serverUrl, target.id, role.id)
          ctx.notify('Role added', `@${target.username} was given ${role.name}.`)
        } else {
          await removeMemberRole(ctx.serverUrl, target.id, role.id)
          ctx.notify('Role removed', `${role.name} was removed from @${target.username}.`)
        }
        return { kind: 'handled' }
      }
      case 'nick': {
        const name = argString.trim()
        if (!name) { ctx.notify('Usage', '/nick <nickname>'); return { kind: 'handled' } }
        await updateProfile(ctx.serverUrl, name)
        ctx.notify('Display name updated', `You are now "${name}".`)
        return { kind: 'handled' }
      }
    }
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string }
    ctx.notify(`/${command.name} failed`, e?.response?.data?.error || e?.message || 'Request failed.')
    return { kind: 'handled' }
  }

  return { kind: 'ignore' }
}

function notFound(ctx: CommandContext, name?: string): CommandResult {
  ctx.notify('User not found', `No member matching "${name ?? ''}".`)
  return { kind: 'handled' }
}
