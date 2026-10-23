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