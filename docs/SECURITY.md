# Security architecture

This document describes the security model of DB Horizon. It is written for
operators and reviewers. Everything here is enforced by the server; the browser
is treated as untrusted.

## Threat model

**Assets**: PostgreSQL data and schema, Neon control-plane resources, dashboard
session/audit data.

**Assumed attacker capabilities**

- Can read everything the browser receives: responses, JS, `localStorage`,
  history, network logs.
- Can submit arbitrary requests to the dashboard API (CSRF-style origin can
  sometimes be forged; we also defend against it).
- May have obtained a leaked connection URL or API key — **this is why the
  dashboard must remain safe even when credentials are disclosed** (see
  “Limits” below).

**What we do not defend against**

- A leaked credential used directly against PostgreSQL/Neon. Only the provider
  (password, API-key scoping, IP allowlists, MFA) can limit that. We document
  this to the user in the UI and in this repo.

## Secrets handling

- Connection URLs, password fragments, and Neon API keys are **never** written
  to:
  - browser storage (localStorage/sessionStorage), frontend state, analytics,
    URLs, or client-side logs;
  - server logs (all logging passes through `redact` — see
    `lib/redact.ts`, which strips connection strings, tokens, auth headers,
    `ghp_`/`sk-`-style keys, and parameters named password/secret/token);
  - the dashboard SQLite store (users table has only the Argon2id hash), or
    audit events (each audit write is redacted before persistence);
  - API responses after authentication.
- Credentials live only in the in-memory `ProviderSessionManager` (per session),
  are wiped on disconnect, sign-out, idle expiry, and server shutdown.

## Application authentication

- Passwords hashed with **Argon2id** (OWASP-configured parameters).
- Session cookie `dbh_sid`: `HttpOnly`, `SameSite=Lax`, `Secure` in production,
  `path=/`.
- CSRF token cookie `dbh_csrf`: readable to JS, double-submit — every state
  changing request must echo `x-csrf-token`.
- Login is protected by two independent controls:
  - a global API limiter (300 req/min per instance) that caps raw volume, and
  - `LoginThrottle` failure-driven lockout: 5 failed attempts lock the account
    for 15 minutes, 20 failed attempts lock the source IP. Blocked attempts
    return `429 RATE_LIMITED` with a `Retry-After` header and an audit row.
  The IP cap is deliberately higher than the account cap so that several people
  behind one NAT cannot lock each other out, and so nobody can weaponise the
  limiter to deny access to a shared office address.
- Unknown users are answered with a dummy Argon2 verify to even out timing; both
  bad-user and bad-password return the identical message.
- Sessions have TTL (default 8 h) and idle timeout (default 30 min); both are
  configurable via env. `/api/auth/reauth` re-verifies the password and stamps a
  short window used by destructive actions.
- Logout revokes the session server-side and destroys the provider connection.
- **No default admin password.** The initial admin is created only from
  `ADMIN_USERNAME`/`ADMIN_INITIAL_PASSWORD` env, and only if the user store is
  empty.

## Authorization

- Every route (except `/healthz` and `/api/auth/login`) requires a valid
  dashboard session.
- Every route re-derives the *session*, *provider connection*, and *capability*
  from the server-side session store. Project/branch/database ids from the
  browser are always validated against the session's own provider resources —
  they are never used as trust anchors.
- Connections are per-session (`ProviderSessionManager`); users cannot see each
  other's connections, saved queries, or audit events.

## SSRF and outbound connection safety

- Database URLs are parsed with `pg-connection-string`, then validated by
  `security/netlib.ts`:
  - only hosts that match approved Neon endpoint patterns are allowed
    (`.neon.tech`); loopback/link-local/private ranges and public-resolver
    rebinding tricks (e.g. `.nip.io`) are rejected;
  - the resolved IP is **pinned** at connect time so a later DNS answer cannot
    redirect the socket (DNS-rebinding defense);
  - TLS verification is mandatory; `sslmode=disable`/`prefer` is rejected and
    `rejectUnauthorized` cannot be disabled by user input.
- The Neon API client talks only to the fixed official Neon API base URL —
  endpoints are constants, never derived from user input.

## SQL safety

- Adapter in `adapters/sql-ident.ts` provides strict identifier quoting
  (`quoteQualified`, `quoteColumn`). Identifiers are validated against a safe
  pattern before they are ever quoted.
- All **values** are sent as parameters (`$1…$n`) via `pg` — never interpolated.
- Row updates/deletes require an unambiguous identity — primary keys when present
  (declared via introspection), else a full-row identity on columns that are
  present, non-generated, and actually unchanged by the operation. The server
  builds a `WHERE` from those columns, verified against the table at execution.
- SQL Studio enforces: statement timeout (configurable), max rows, max result
  bytes, and a max number of statements per request. Queries run under the
  connected role's privileges — never elevated. Every statement is classified
  server-side (`lib/sql-classify.ts`); anything that is not positively
  read-only or transaction control returns `403 CONFIRMATION_REQUIRED` until the
  operator acknowledges it, and single-statement execution means stacked
  statements are rejected by PostgreSQL itself.
- Destructive schema/data statements require confirmation; schema endpoints
  generate SQL by building ASTs from validated inputs, never by string-pasting
  untrusted fragments.

## Destructive-action guardrails

For deleting/altering rows, tables, columns, databases, branches, projects:

1. The UI renders the exact target and consequences.
2. A typed confirmation matches the target name/id.
3. The server independently re-validates the target, requires an explicit
   `confirm` flag, and requires **recent reauthentication** for sensitive paths
   (checked server-side against the session's reauth timestamp).
4. The outcome is written to the audit log (redacted) — see `api/audit-router.ts`
   and `security/audit.ts`.

## Transport & headers

- `helmet` sets security headers; CSP is strict in production.
- `express.json` body limit 1 MB; uploads limited by `MAX_UPLOAD_BYTES`.
- Global rate limit (300 req/min per IP, tightened per-route).
- CORS restricted to configured origins with credentials; the Vite dev origin is
  allowed in development only.
- `trust proxy` and cookie `Secure` must be enabled behind a TLS-terminating
  reverse proxy (see OPERATIONS.md).

## Audit log

- Every auth event, connection attempt, SQL execution, schema change, import and
  destructive action is written **with user and session**. The persisted audit
  log is enabled by default and can be disabled in Settings; a structured
  server-log trail is written even when the store-level audit is off.
- Redaction is pattern-based (authorization headers, URL query parameters, SQL
  connection-string passwords). Call sites that hold a live credential pass it
  explicitly to `redact()` (see `sql-router`), so free-text detail such as
  `statement=... rows=...` stays readable. Detail is never treated as a secret
  value itself — doing so would replace the whole string with `[REDACTED]` and
  defeat the purpose of the log.
- `/api/audit` returns only the caller's events; the UI's Security page shows
  them.
- Audit rows are pruned after `retentionDays` (default: 90 days).

## Limits of the model

- Dashboard authorization cannot stop direct use of a leaked URL/key.
- Rate limits and session TTLs mitigate, but do not eliminate, brute force of a
  strong password; use a long, random admin password.
- The `COOKIE_SECRET` default (`dev-insecure-secret-change-me`) is for local
  development only — always set a real secret in production, otherwise sessions
  can be forged by someone who knows the source.