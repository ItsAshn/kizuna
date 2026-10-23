import { describe, expect, it } from 'vitest'
import { chooseSocketRtpFraming } from './socketRtpFraming'

describe('chooseSocketRtpFraming', () => {
  it('picks the best framing both sides support', () => {
    expect(chooseSocketRtpFraming({ supported: [1, 2] })).toBe(2)
    expect(chooseSocketRtpFraming({ supported: [2] })).toBe(2)
  })

  it('falls back to bare payloads when the client only knows framing 1', () => {
    expect(chooseSocketRtpFraming({ supported: [1] })).toBe(1)
  })

  it('ignores framings it does not speak', () => {
    expect(chooseSocketRtpFraming({ supported: [3, 9] })).toBe(1)
    expect(chooseSocketRtpFraming({ supported: [3, 2] })).toBe(2)
  })

  it('still understands the single-framing request of older clients', () => {
    expect(chooseSocketRtpFraming({ framing: 2 })).toBe(2)
    expect(chooseSocketRtpFraming({ framing: 1 })).toBe(1)
  })

  it('treats a missing or malformed request as framing 1', () => {
    expect(chooseSocketRtpFraming(undefined)).toBe(1)
    expect(chooseSocketRtpFraming(null)).toBe(1)
    expect(chooseSocketRtpFraming(() => {})).toBe(1)
    expect(chooseSocketRtpFraming({ framing: '2' })).toBe(1)
  })
})
