import { describe, expect, it } from 'vitest'
import { envBool } from './config'

describe('envBool', () => {
  const parse = (v: unknown, def = false) => envBool(def).parse(v)

  it('treats "false" and other non-truthy strings as false', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', 'nope', ' ']) {
      expect(parse(v, true)).toBe(false)
    }
  })

  it('accepts the documented truthy spellings, case- and space-insensitive', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'on']) {
      expect(parse(v)).toBe(true)
    }
  })

  it('falls back to the default when unset or empty', () => {
    expect(parse(undefined, true)).toBe(true)
    expect(parse('', true)).toBe(true)
    expect(parse(undefined, false)).toBe(false)
  })

  it('passes real booleans through', () => {
    expect(parse(true)).toBe(true)
    expect(parse(false, true)).toBe(false)
  })
})
