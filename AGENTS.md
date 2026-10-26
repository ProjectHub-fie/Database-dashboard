# DB Remote — development guide

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

- **Organization-scoped Neon API keys get 404 on `GET /users/me`.** Neon returns
  404 "not allowed for organization API keys", not 401. Treating that as an
  invalid credential rejects perfectly good keys. `validateApiKey()` confirms
  such keys via `/projects` and returns `organizationScoped: true`; only a real
  401 fails validation.
- **A connection session can vanish mid-session.** Idle expiry, a backend
  restart, or a failover to an instance that never held the pool all produce
  `401 UNAUTHORIZED`. The client emits `onConnectionLost()` for non-auth 401s,
  `AuthContext` clears `connected`, and `RequireConnection` returns the user to
  `/connect`. Never render dashboard chrome from a cached status without it.
- **Advertise only capabilities the current auth can actually use.**
  `capabilitiesForAuth(caps, 'connection')` strips `control.*` and
  `monitoring.*`; without it a database-URL session shows provider-management
  navigation that the server answers with 401.

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

- **A 404 from `/api` almost never means a missing route — check the deploy
  first.** Every `/api` path must answer with the JSON envelope
  `{ error: { code, message } }`; an HTML page means the request never reached
  Express (the platform answered instead). Run
  `scripts/check-deploy.sh <base-url>` to tell the two apart. The usual cause is
  a Vercel project whose Root Directory is not the repo root, so
  `api/[...path].ts` is never built; the second is `API_ORIGIN` unset or pointing
  at this same deployment. `deploy-config.test.ts` and
  `api/api-404-contract.test.ts` guard the wiring, and the client renders
  `ApiUnreachableBanner` when it sees a non-JSON `/api` response.
- **On the Vercel edge, `req.headers['host']` / `x-forwarded-host` seen by the
  function is often the *deployment* host (`<deploy>.vercel.app`), not the public
  alias the browser used (`dbremote.vercel.app`).** So a naive self-reference
  guard comparing origin host vs request host lets `API_ORIGIN`
  pointing at the deployment look usable and silently proxies `/api/*` to the
  SPA fallback (plain-text 404). The guard in `api/[...path].ts` now treats any
  `*.vercel.app`/`*.now.sh`/`*.vercel.dev`/loopback origin as `API_ORIGIN_LOOP`
  (503 JSON) regardless of request host — a serverless host can never be the
  persistent API.
- **The Vercel project env var doesn't always reach a fresh deploy's runtime.**
  When this project's `API_ORIGIN` (added via CLI `env add`) kept behaving like
  an old/stale value across `deploy --prod --force`, only a deploy with explicit
  `--env API_ORIGIN=...` flags actually changed runtime behavior. Delete and
  re-add the env var (or pass `--env` at deploy time) until `/api/healthz`
  reflects the value; Vercel secrets can't be read back by the API (empty
  `value` in `v9/projects/{id}/env`) so verify by behavior, not by inspection.
- **`dbremote.vercel.app` is the Vercel SPA alias and cannot serve as
  `API_ORIGIN`.** The stateful Express API (pg pools, SQLite, in-memory secrets)
  runs on a persistent host; the `work-1/2` `all-hands.dev` tunnel hosts are
  session-scoped and unreachable from Vercel (egress answers
  `AMBIGUOUS_UPSTREAM`, not the API), so production `/api` only works when
  `API_ORIGIN` points at a genuinely public persistent server.
- **Routes are mounted in exactly one place: `src/api/routes.ts`.** Both
  `index.ts` and the test harness call `registerApiRoutes`. Do not re-add router
  wiring to either file — when they were duplicated the deployed app could serve
  a route the tests never exercised, which is how a UI panel 404s in production
  only. `api/client-routes.test.ts` fails if the client calls an unserved path.

- **`UNAUTHORIZED` on a non-auth route means "session lost" to the client.**
  `lib/api.ts` turns any 401 into `onConnectionLost()`, which clears the
  connection and bounces the operator to `/connect`. Never use 401 to signal
  "this connection mode lacks that feature" — use `FEATURE_UNAVAILABLE` (403),
  as `allocatePrimary` does for `accountOnly` API-key sessions. A 401 there made
  API-key sessions log themselves out on the first click of any data page.
  Nav sections that need a live SQL connection carry `needsDatabase` so they are
  hidden, not offered-and-failing, in API-key mode.
- **Account-only routes answer 403 under anonymous mode, not 401.** `requireUser`
  guards saved queries (`/api/sql/saved`) and audit history (`/api/audit`), which
  an anonymous connection can reach but cannot own. Answering 401 there reads as
  "session lost" to `lib/api.ts`, so opening SQL Studio (which fetches
  `/api/sql/saved` on mount) signed the operator out just for tapping the page.
  The guard now returns `FEATURE_UNAVAILABLE` (403) when `AUTH_REQUIRED=false`
  and keeps 401 only when auth is enforced. `anonymous-mode.test.ts` pins it,
  and `client/src/lib/api.test.ts` pins the client half of the contract.
- **`dbh_csrf` must be re-issued, not only minted.** `anonymousSession` writes
  the cookie when the browser does not already hold the token derived from its
  session ref. Setting it only on `isNew` broke sign-out → sign-in: logout
  clears `dbh_csrf` but leaves the still-valid `dbh_anon`, so nothing ever
  re-sent the token and every later write was a 403 until the anon cookie aged
  out. Guarded by `anonymous-mode.test.ts`.
- **`POST /api/connections/preview` never opens a connection.** It validates URL
  shape, host allowlist and DNS pinning only, then returns metadata; a wrong
  password is not caught until `POST /api/connections/url`. The UI labels it
  "Test connection", so copy must not imply the credential was verified.

- **API-key sessions attach a database to get a SQL surface.** Connecting with
  only a Neon API key creates an `accountOnly` session (control plane only).
  The operator attaches a database via `POST /api/connections/database`, which
  asks the control plane for a credential-bearing `connection_uri`, runs it
  through `verifyNeonConnectionUrl` (allowlist, private-range rejection, DNS
  pinning) and opens the same pinned-TLS `pg` client URL mode uses. The URI
  never leaves the server; its password goes into the session's `secretHints`.
  `auth` stays `'api'`, so control-plane routes keep working once a database is
  attached. To add another provider, implement the optional
  `ControlPlaneAdapter.getConnectionUri()` (see docs/PROVIDERS.md). The Neon
  client method is `getConnectionUri` → `GET /projects/{id}/connection_uri`.
