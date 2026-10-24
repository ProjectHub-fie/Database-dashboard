import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `pg` has no type parser for `name[]` (OID 1003), so a bare
 * `ARRAY(SELECT attname ...)` arrives in JS as the literal string `{id,email}`.
 * That reached the UI as a non-array and crashed the table detail panel. Every
 * catalog array of identifiers must therefore be cast to `text[]`.
 */
const source = readFileSync(join(import.meta.dirname, 'postgres.ts'), 'utf8')

function count(needle: string): number {
  return source.split(needle).length - 1
}

describe('catalog array decoding', () => {
  it('casts every identifier array to text[] before it reaches JS', () => {
    // Each ARRAY(SELECT name ...) subquery yields name[]; one cast each.
    expect(count('ARRAY(SELECT')).toBeGreaterThanOrEqual(4)
    expect(count('::text[]')).toBe(count('ARRAY(SELECT'))
  })
})
