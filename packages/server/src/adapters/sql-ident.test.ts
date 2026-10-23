import { describe, it, expect } from 'vitest'
import { quoteIdent, quoteQualified, quoteRef, assertSafeResourceName, DATABASE_NAME_RE } from './sql-ident.js'

describe('safe identifier quoting', () => {
  it('quotes valid identifiers', () => {
    expect(quoteIdent('users')).toBe('"users"')
    expect(quoteIdent('user_1')).toBe('"user_1"')
    expect(quoteQualified('public', 'users')).toBe('"public"."users"')
    expect(quoteRef('public', 'users')).toBe('"public"."users"')
  })

  it('rejects identifiers that could inject SQL', () => {
    for (const bad of [
      'users; DROP TABLE x',
      'a"b',
      '1abc',
      '-bad',
      'user.name',
      '',
      'x'.repeat(64),
    ]) {
      expect(() => quoteIdent(bad)).toThrow()
    }
  })

  it('validates resource names for provider params', () => {
    expect(assertSafeResourceName('main_db', 'database', DATABASE_NAME_RE)).toBe('main_db')
    expect(() => assertSafeResourceName('bad name!', 'database', DATABASE_NAME_RE)).toThrow()
  })
})

describe('quoteRef', () => {
  it('quotes unqualified refs with only a name', () => {
    expect(quoteRef(undefined, 'users')).toBe('"users"')
  })
})