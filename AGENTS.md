# DB Horizon — development guide

Multi-provider remote database management dashboard. Neon PostgreSQL is the first
implemented provider. Build commands:

- `npm install` at repo root
- `npm run dev` — starts server (tsx watch :3001) and client (vite :5173) via workspaces
- `npm run test -w server` — vitest suite (unit, API integration, security)
- `npm run build` — typecheck + build both packages
- `npm run start -w server` — serve built API (serves ./client/dist)
- `npm run typecheck` — TS checks for both packages

## Architecture rules

- Server main entry: `packages/server/src/index.ts` (startApp keeps server
  handle-able for tests).
- Providers live in `src/providers` (types/registry) + `src/adapters`
  (per-engine) + `src/providers/neon` (Neon control-plane). Future providers
  must implement the `Provider` interface in `src/providers/types.ts` and
  register via `ProviderRegistryImpl`; contract enforced by
  `assertProviderContract` and contract tests.
- Capability-driven UI: the client derives sidebar entries and buttons from
  `GET /api/capabilities`. Never hardcode "Neon" UI behaviors.
- Secrets never enter: browser responses, frontend state, analytics, URLs,
  client logs, or the dashboard SQLite store. All redaction flows through
  `src/lib/redact.ts`. Keep the connection credential (URL password / role, or
  Neon API key) in the in-memory session manager only.
- Query identifiers must be quoted via `quoteQualified`/`quoteColumn`
  (`src/adapters/sql-ident.ts`); values always map to `$1..$n` parameters.
- Host/SSRF guard: `src/security/netlib.ts` pins the validated Neon host to a
  resolved A/AAAA address and `src/adapters/pinned-socket.ts` forces the socket
  to that IP while `pg` still verifies the TLS certificate against the original
  hostname. Never add unrestricted host allowlisting.
- Error responses: AppError in `src/lib/errors.ts`; safe message to browser,
  internal `detail` to server logs only.
- Node >= 22.5 for `node:sqlite` (used for dashboard metadata storage).
- Tests mock the Neon HTTP API (nock-style, via fetch mock) and use fake pg
  adapters; they must not need a real Neon account or a live PostgreSQL.

## Neon API facts (from official docs, Jul/Aug 2026 OpenAPI v2)

- Base URL `https://console.neon.tech/api/v2`, auth `Authorization: Bearer <key>`.
- Users: `GET /users/me`, `GET /users/me/organizations`.
- Projects: `GET/POST /projects` (`org_id`, `cursor`, `limit` params), `GET
  /projects/{project_id}`, `DELETE /projects/{project_id}`, `GET
  /projects/{project_id}/connection_uri?database_name&role_name[&branch_id&endpoint_id&pooled]`.
- Branches: `GET/POST /projects/{project_id}/branches`
  (`{"branch":{"name":...}}`), `DELETE /projects/{project_id}/branches/{branch_id}`.
- Databases: `GET/POST /projects/{project_id}/branches/{branch_id}/databases`
  (`{"database":{"name","owner_name"}}`), `DELETE
  /projects/{project_id}/branches/{branch_id}/databases/{database_name}`.
- Endpoints: `GET /projects/{project_id}/endpoints`.
- Operations: `GET /projects/{project_id}/operations`, `GET
  /projects/{project_id}/operations/{operation_id}`; status enum:
  `scheduling|running|finished|failed|error|cancelling|cancelled|skipped`.
- Consumption (usage): `GET /consumption_history/v2/projects` and
  `/consumption_history/v2/branches`.
- Delete responses include `operations[]`; creation endpoints return
  `operations[]` too. Poll until `finished`/`failed`/`error` before reporting
  success.
## Gotchas found in practice

- **`Set` never survives JSON — capability ids must be serialized explicitly.**
  Providers declare `capabilities` as a `ReadonlySet<Capability>`;
  `JSON.stringify(new Set([...]))` is `{}`, so any endpoint returning the raw
  object gave the browser `capabilities: {}`, and `{}.includes(...)` threw
  `includes is not a function` (Import/Export crashed on open). Always pass
  capability objects through `serializeCapabilities()` (`providers/registry.ts`)
  and read them client-side via `capabilitiesOf()` (`client/src/lib/capabilities.ts`).
  `capabilities-wire.test.ts` pins the array contract at the wire level.
- **API responses must send `Cache-Control: no-store`.** The CSRF cookie is
  minted lazily by `anonymousSession`/`sessionMiddleware`. With default caching
  (Express ETags + Vercel edge) a revalidated or `304` GET drops `Set-Cookie`,
  leaving the browser without `dbh_csrf` and producing a phantom
  `403 Invalid or missing CSRF token` on the first write. `index.ts` sets
  `no-store` for all of `/api`.
- **CSRF is a double submit; the client must bootstrap and retry.** The token
  lives in a readable `dbh_csrf` cookie echoed as `x-csrf-token`. A write fired
  before any API read, or after the backend restarted and lost its in-memory
  anonymous store, sends a token the server cannot match. `client/src/lib/api.ts`
  mints the cookie when absent and retries a CSRF 403 exactly once.
- **`pg` does not decode `name[]` (oid 1003).** Catalog queries that aggregate
  `pg_attribute.attname` or `pg_class.relname` into arrays return raw literals
  (`{email}`) instead of `string[]`. Always cast those subqueries to `::text[]`
  (see the `member_of`, `enum_values`, unique-constraint and index-column
  queries in `src/adapters/postgres.ts`). `postgres-catalog.test.ts` guards it.
- **`asAppError()` must map `ZodError` to `BAD_REQUEST`.** Otherwise a request
  body that fails schema validation falls through to `INTERNAL` and returns 500
  with schema internals. Route handlers should validate with Zod and let
  `asAppError` translate.
- **Connection credentials require a dashboard session.** `POST
  /api/connections/url` and `/api/connections/api` sit behind `requireAuth`, and
  the session manager keys provider credentials by session id. The entry screen
  keeps the connection tabs visible when signed out and hands over to the
  account tab instead of hiding them; do not "fix" this by allowing anonymous
  connection creation.
- **`netlib.ts` error messages may name the host, never the password.** A masked
  host (`***`) makes a rejected connection impossible to diagnose. The host has
  already passed the charset allowlist at that point and is user-supplied, so
  echo it; keep `redact()` covering the credential.
- **Vercel hosts the SPA only.** `api/[...path].ts` reverse-proxies `/api/*` to
  `API_ORIGIN`; the Express API needs a persistent host because sessions are
  SQLite-backed and connection pools/secrets are in-memory. Keep the
  `/api/` exclusion in the SPA rewrite, otherwise API paths return `index.html`.
