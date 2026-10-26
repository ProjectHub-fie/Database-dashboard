/**
 * Offline operator tool: provision a dashboard account from environment
 * variables. `AUTH_REQUIRED=true` deployments use this to create or reset the
 * initial admin without a live session (the app itself never invents
 * credentials). Usage from packages/server:
 *
 *   ADMIN_USERNAME=admin ADMIN_INITIAL_PASSWORD=<pw> npx tsx src/cli/reset-admin.ts
 *
 * Rules mirror `createInitialAdmin`:
 *  - password is required and must be at least 12 characters;
 *  - the account is flagged must_change_password=1 so the first interactive
 *    sign-in must rotate it before the password is relied on;
 *  - the operation is local-only. It touches nothing outside the SQLite store.
 */
import { loadConfig } from '../config.js'
import { Store } from '../storage/store.js'
import { argon2idOptions } from '../security/auth.js'
import { createLogger } from '../lib/logger.js'
import { AppError } from '../lib/errors.js'
import { dashboardStorePath } from '../lib/store-path.js'

async function run(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger()

  const username = process.env.ADMIN_USERNAME ?? 'admin'
  const password = process.env.ADMIN_INITIAL_PASSWORD
  if (!password) {
    throw new AppError({
      code: 'INTERNAL',
      message: 'ADMIN_INITIAL_PASSWORD is required to reset an admin account',
    })
  }
  if (password.length < 12) {
    throw new AppError({
      code: 'INTERNAL',
      message: 'ADMIN_INITIAL_PASSWORD must be at least 12 characters',
    })
  }

  const store = new Store(dashboardStorePath(config.dataDir), { logger })

  const { default: argon2 } = await import('argon2')
  const hash = await argon2.hash(password, argon2idOptions)

  const user = store.updateUserCredentials(username, hash)
  logger.info(
    { username: user.username, userId: user.id, mustChangePassword: user.mustChangePassword },
    'admin account provisioned',
  )
}

run().then(
  () => process.exit(0),
  (err: unknown) => {
    const logger = createLogger()
    logger.error({ err }, 'admin reset failed')
    process.exit(1)
  },
)