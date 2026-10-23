# DB Horizon

Multi-provider remote database management dashboard. **Neon PostgreSQL is the first
implemented provider**; the provider registry and capability system are designed so
additional providers (Supabase, RDS, …) can be added without rewriting the core
application.

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database driver**: `pg` with TLS verification and server-side pooling
- **Provider control plane**: official Neon API v2 through a dedicated server-side service
- **Validation**: Zod
- **Storage**: `node:sqlite` (dashboard's own auth / audit store)

## Highlights

- **Two connection modes**
  - *Database URL* — direct PostgreSQL connection to exactly one database. TLS is
    verified, outbound hosts are validated with DNS pinning (SSRF / DNS-rebinding
    protection), and account-level Neon management is intentionally unavailable.
  - *Neon API key* — authenticated against the official Neon API. Projects,
    organizations, branches, databases, compute endpoints, and asynchronous
    operations are managed through the provider control-plane API.
- **Application authentication** — Argon2id password hashing, HttpOnly + SameSite
  session cookies, CSRF double-submit defense, login throttling, rate limits,
  session TTL + idle expiration, and session revocation.
- **Capability-driven UI** — the sidebar and every button are derived from the
  connected provider's declared capabilities. Unsupported features are hidden or
  disabled with an explanation; nothing is faked.
- **Security by default** — secrets live only in server memory for the session,
  all logging is redacted, and destructive actions require explicit confirmation,
  a typed target, and recent reauthentication.
- **SQL Studio** — CodeMirror editor with syntax highlighting, saved queries,
  history, statement timeout, cancellation, result limits, and parameterized
  values. Result grid supports pagination, copy and export.
- **Import / Export** — CSV import with column mapping, preview, batch sizes and
  transactional rollback; CSV / JSON export capped at a safe row limit.

## Repository layout

```
packages/
  server/
    src/
      api/            Express routers (auth, connections, data, sql, schema,
                      control-plane, audit)
      adapters/       Database-engine adapters (PostgreSQL via pg)
      providers/      Provider registry + neon control-plane client
      security/       netlib host guard, auth (Argon2id), sessions, audit
      storage/        node:sqlite store (users, sessions, audit, saved queries)
      lib/            Zod schemas, redaction, errors, logger
    migrations/       SQL migration files
  client/
    src/
      components/     AppShell, UI primitives
      contexts/       Auth, theme, toast
      pages/          Overview, Data Browser, SQL Studio, Schema Manager,
                      Projects, Branches, Databases, Roles, Operations,
                      Monitoring, Import/Export, Settings, Security
      lib/            API client, types
```

## Quick start (development)

```bash
npm install
cp .env.example packages/server/.env   # set ADMIN_USERNAME + ADMIN_INITIAL_PASSWORD
npm run dev
```

- Server: `http://localhost:3001`
- Client (Vite dev proxy to the API): `http://localhost:5173`

## Production build

```bash
npm run build        # typechecks + builds client and server
npm run start        # NODE_ENV=production server; serves ./client/dist
```

## First sign-in

There is **no default password**. On first start, the server creates the initial
admin only when `ADMIN_USERNAME` (default `admin`) and `ADMIN_INITIAL_PASSWORD`
(required, ≥ 12 chars) are present in the environment. Sign in with those
credentials.

## Connecting to Neon

See [docs/CONNECTING.md](docs/CONNECTING.md) for:
- Database URL connection instructions
- Neon API key setup (scoped keys and blast radius)
- How to choose between the two modes

## Documentation

- [docs/CONNECTING.md](docs/CONNECTING.md) — connection guides
- [docs/SECURITY.md](docs/SECURITY.md) — security architecture
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — deployment, credential rotation,
  and incident response
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — provider registry guide and contract
  tests

## Testing

```bash
npm test             # server vitest suite (unit, API integration, security)
```

The suite currently includes:

| File | Coverage |
| --- | --- |
| --- | --- |
| `providers/contract.test.ts` | provider registry + contract enforcement (6 tests) |
| `adapters/sql-ident.test.ts` | safe identifier quoting (4 tests) |
| `security/netlib.test.ts` | SSRF host guard / DNS pinning + TLS can't-be-disabled (10 tests) |
| `lib/sql-classify.test.ts` | destructive-statement confidence gating (6 tests) |
| `lib/redact.test.ts` | secret redaction (6 tests) |
| `api/security.test.ts` | auth, CSRF, session isolation, disconnect revocation, recent-reauth gate (8 tests) |
| `api/audit.test.ts` | audit log scoping + redaction (4 tests) |
| `api/errors.test.ts` | safe error mapping (3 tests) |

**47/47 pass**, plus `tsc` clean on both packages.

Runtime database and Neon API calls are mocked only in tests; the real
application uses genuine PostgreSQL connections and Neon API v2 responses.

## Security posture

- Credentials never reach the browser, logs, URLs, analytics, or persistent
  storage.
- Outbound connections are validated against the approved Neon host allowlist
  with DNS pinning; TLS certificate verification cannot be disabled by user
  input.
- SQL values are parameterized (`$1…$n`), identifiers are quoted via
  `sql-ident`, and row updates/deletes use primary-key identities.
- Resource ownership is enforced server-side on every request; the browser is
  never trusted with project/branch/database ids.
- Audit events are stored per-user and redacted (see `docs/SECURITY.md`).

> **Limitation you must understand**: dashboard authorization cannot stop someone
> who already possesses a leaked database URL or API key from connecting to your
> resources directly. Rotate credentials when they may have leaked — see
> [docs/OPERATIONS.md](docs/OPERATIONS.md).