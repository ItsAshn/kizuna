import { describe, it, expect } from 'vitest'
import {
  MAX_RENDERED_TEXT,
  OUTGOING_WEBHOOK_EVENTS,
  isChannelScopedEvent,
  isOutgoingWebhookEvent,
  renderEventText,
  truncateText,
  webhookSignatureBase,
} from './webhookEvents'

describe('isOutgoingWebhookEvent', () => {
  it('accepts known event names', () => {
    expect(isOutgoingWebhookEvent('message.created')).toBe(true)
    expect(isOutgoingWebhookEvent('member.removed')).toBe(true)
  })

  it('rejects unknown values', () => {
    expect(isOutgoingWebhookEvent('message.exploded')).toBe(false)
    expect(isOutgoingWebhookEvent('')).toBe(false)
    expect(isOutgoingWebhookEvent(null)).toBe(false)
    expect(isOutgoingWebhookEvent(42)).toBe(false)
  })

  it('does not accept inherited Object properties', () => {
    expect(isOutgoingWebhookEvent('toString')).toBe(false)
    expect(isOutgoingWebhookEvent('constructor')).toBe(false)
  })
})

describe('isChannelScopedEvent', () => {
  it('marks message events as channel-scoped', () => {
    expect(isChannelScopedEvent('message.created')).toBe(true)
    expect(isChannelScopedEvent('channel.updated')).toBe(true)
  })

  it('marks server-wide events as not channel-scoped', () => {
    expect(isChannelScopedEvent('member.joined')).toBe(false)
    expect(isChannelScopedEvent('channel.created')).toBe(false)
  })
})

describe('renderEventText', () => {
  it('renders a message with channel and author', () => {
    const text = renderEventText('message.created', {
      channel: { id: 'c1', name: 'general' },
      user: { username: 'alice' },
      message: { id: 'm1', content: 'hello world' },
    })
    expect(text).toBe('**#general** · @alice: hello world')
  })

  it('degrades gracefully when fields are missing', () => {
    const text = renderEventText('message.created', {})
    expect(text).toBe('**a channel** · someone:')
  })

  it('renders member events without a channel', () => {
    expect(renderEventText('member.joined', { user: { username: 'bob' } })).toBe(
      '👋 @bob joined the server',
    )
    expect(renderEventText('member.removed', { user: { username: 'bob' }, reason: 'spam' })).toBe(
      '🚫 @bob was removed from the server — spam',
    )
  })

  it('renders a ping', () => {
    expect(renderEventText('ping', {})).toContain('Test delivery')
  })

  it('truncates long message content to the Discord-safe cap', () => {
    const text = renderEventText('message.created', {
      channel: { id: 'c1', name: 'general' },
      user: { username: 'alice' },
      message: { id: 'm1', content: 'x'.repeat(5000) },
    })
    expect(text.length).toBe(MAX_RENDERED_TEXT)
    expect(text.endsWith('…')).toBe(true)
  })

  it('covers every declared event', () => {
    for (const { key } of OUTGOING_WEBHOOK_EVENTS) {
      const text = renderEventText(key, {
        channel: { id: 'c1', name: 'general' },
        user: { username: 'alice' },
        message: { id: 'm1', content: 'hi' },
      })
      expect(text).not.toContain('Kizuna event:')
      expect(text.length).toBeGreaterThan(0)
    }
  })
})

describe('truncateText', () => {
  it('leaves short text untouched', () => {
    expect(truncateText('short', 10)).toBe('short')
  })

  it('caps at exactly max, ellipsis included', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcd…')
  })
})

describe('webhookSignatureBase', () => {
  it('joins timestamp and body with a dot', () => {
    expect(webhookSignatureBase(1700000000, '{"a":1}')).toBe('1700000000.{"a":1}')
  })

  it('changes when the timestamp changes, so replays fail verification', () => {
    const body = '{"a":1}'
    expect(webhookSignatureBase(1, body)).not.toBe(webhookSignatureBase(2, body))
  })
})
