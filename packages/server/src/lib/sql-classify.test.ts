import { describe, it, expect } from 'vitest'
import { classifyStatement, requiresConfirmation, firstKeyword } from '../lib/sql-classify.js'

describe('SQL statement classification', () => {
  it('treats plain reads as read-only', () => {
    for (const sql of [
      'SELECT * FROM customers',
      '  select 1',
      '-- comment\nSELECT now()',
      '/* block */ SHOW search_path',
      'EXPLAIN SELECT 1',
      'VALUES (1), (2)',
      'TABLE customers',
    ]) {
      expect(classifyStatement(sql)).toBe('read')
      expect(requiresConfirmation(sql)).toBe(false)
    }
  })

  it('treats transaction helpers as non-destructive', () => {
    for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT a', 'SET statement_timeout = 1000']) {
      expect(requiresConfirmation(sql)).toBe(false)
    }
  })

  it('requires confirmation for data and structure changes (fails closed)', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'DELETE FROM t',
      'TRUNCATE t',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN c int',
      'CREATE INDEX i ON t (a)',
      'GRANT ALL ON t TO someone',
      'COPY t FROM STDIN',
      'DO $$ BEGIN DELETE FROM t; END $$',
      'WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone',
    ]) {
      expect(classifyStatement(sql)).toBe('destructive')
      expect(requiresConfirmation(sql)).toBe(true)
    }
  })

  it('does not let leading whitespace or comments hide a destructive verb', () => {
    expect(firstKeyword('\n\t /* hi */ \n  /* x */\n  drop table t')).toBe('drop')
    expect(requiresConfirmation('\n\n-- harmless?\n/* no */ DELETE FROM t')).toBe(true)
  })

  it('fails closed on empty input', () => {
    expect(classifyStatement('   ')).toBe('destructive')
    expect(classifyStatement('-- only a comment')).toBe('destructive')
  })
})

describe('destructive guard', () => {
  it('sanity: reads free, writes gated', () => {
    expect(requiresConfirmation('SELECT 1')).toBe(false)
    expect(requiresConfirmation('INSERT')).toBe(true)
  })
})
