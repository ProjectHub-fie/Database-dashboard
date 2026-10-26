import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dashboardStorePath } from './store-path.js'

describe('dashboardStorePath', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbh-store-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('uses the current filename on a fresh install', () => {
    expect(dashboardStorePath(dir)).toBe(path.join(dir, 'db-remote.sqlite'))
  })

  it('keeps using a pre-rename database instead of starting empty', () => {
    const legacy = path.join(dir, 'db-horizon.sqlite')
    fs.writeFileSync(legacy, '')
    expect(dashboardStorePath(dir)).toBe(legacy)
  })

  it('prefers the current filename once it exists', () => {
    fs.writeFileSync(path.join(dir, 'db-horizon.sqlite'), '')
    const current = path.join(dir, 'db-remote.sqlite')
    fs.writeFileSync(current, '')
    expect(dashboardStorePath(dir)).toBe(current)
  })

  it('stays in memory when no data directory is configured', () => {
    expect(dashboardStorePath('')).toBe(':memory:')
  })
})
