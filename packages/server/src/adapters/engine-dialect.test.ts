import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostgresAdapter } from './postgres.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..')

describe('Engine dialect contract (multi-provider readiness)', () => {
  it('declares PostgreSQL dialect rules instead of assuming them in shared code', () => {
    const adapter = new PostgresAdapter()
    expect(adapter.dialect.kind).toBe('postgres')
    expect(adapter.dialect.placeholder(1)).toBe('$1')
    expect(adapter.dialect.placeholder(3)).toBe('$3')
    expect(adapter.dialect.defaultPort).toBe(5432)
    expect(adapter.dialect.schemaModel).toBe('namespace')
    // Identifier quoting must reject hostile input, not escape it blindly.
    expect(adapter.dialect.quoteIdentifier('users')).toBe('"users"')
    expect(() => adapter.dialect.quoteIdentifier('users; DROP TABLE x')).toThrow()
  })

  it('keeps PostgreSQL placeholder syntax out of the shared API layer', () => {
    // A MySQL adapter uses `?` placeholders. Shared routers must therefore never
    // build `$n` text themselves, or the dialect boundary would be unenforceable.
    const offenders: string[] = []
    for (const dir of ['api', 'providers', 'security', 'lib']) {
      for (const file of walk(join(srcDir, dir))) {
        if (file.endsWith('.test.ts')) continue
        const body = readFileSync(file, 'utf8')
        // Matches template interpolation that emits a numeric placeholder.
        if (/\$\{params\.length\}/.test(body) || /\$\$\{/.test(body)) {
          offenders.push(file.replace(srcDir, ''))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}
