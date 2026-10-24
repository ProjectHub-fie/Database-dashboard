# Connecting to Neon

## The sign-in screen

`/login` (also served at `/connect`) hosts all three ways in as tabs.

| Tab | Purpose | Needs a dashboard session? |
| --- | --- | --- |
| Dashboard account | Identifies the person; issues the HttpOnly session cookie | — |
| Database URL | SQL access to exactly one database | Yes |
| Provider API key | Neon control-plane access | Yes |

Both connection tabs need a session first. Provider credentials are bound to the
session id on the server and every `/api` route is authorized per user, so an
anonymous request cannot open either kind of connection. When you fill in a
connection form while signed out, clicking the submit button switches to the
account tab with an explanation; what you typed stays in page memory (never in
`localStorage`/`sessionStorage`) and is still there after signing in.

Both forms take an optional **display name**. It is a label for the operator
("Production read replica"), stored as non-secret metadata, and shown in the
status bar. It is never used as a credential.

Provider options come from `GET /api/providers`. Only providers with
`available: true` are selectable; the rest are listed as planned, not fake.

## Database URL mode

A Neon pooled or unpooled connection string looks like:

```text
postgres://neondb_owner:<password>@ep-<endpoint>.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Paste it into the *Database URL* tab on the sign-in screen.

**Test connection** validates the string without opening a session: it checks the
scheme, rejects IP literals and non-Neon hosts, resolves DNS, and returns only
safe metadata (host, port, database, role, read-only-or-not). The password never
travels back to the browser. The error message names the rejected host so a typo
is diagnosable, but never the credential.

### What connecting this way gives you

- A live PostgreSQL connection to **exactly the database in the URL**.
- SQL Studio, Data Browser, Schema Manager, Overview, Monitoring, Roles/Grants and
  Import/Export for that database.
- The **actual permission scope of the role in the URL**. The dashboard does not
  and cannot widen those permissions. A read-only role produces read-only
  workflows; permission-denied errors are reported as they come back from
  PostgreSQL.

### What it intentionally does *not* give you

- Your other Neon projects, branches, databases, roles or billing. In this mode
  the dashboard calls the PostgreSQL server only — it never contacts the Neon
  API, because a connection string does not prove you own the account.
- Provider-level management (creating projects/branches, inspecting compute
  endpoints, backups). Use API-key mode for those.

### Safety properties

- TLS is required with **certificate verification**. `sslmode=disable`,
  `sslmode=prefer`, or any option that weakens verification is rejected.
- The submitted hostname is validated against approved Neon PostgreSQL endpoints
  (hostnames ending in `neon.tech` that look like Neon endpoint hosts). DNS
  rebinding is prevented by pinning the resolved IP at connect time (see
  `security/netlib.ts`).
- URLs are never returned to the browser, never stored, and never logged. On
  disconnect the in-memory session pool is destroyed.

## Neon API key mode

1. Go to **Neon Console → Settings → API keys** (or use the Neon CLI:
   `neonctl api-keys create --name db-horizon`).
2. Create a **project-scoped** key when possible. A key scoped to one project can
   only manage that project; an account key can manage everything your account
   can. Project-scoped keys drastically reduce the blast radius of a leak.
3. Paste the key into the *Neon API key* tab on the Connect screen. The key is
   sent once over HTTPS to the dashboard backend, validated against the official
   Neon API, and then kept only in server memory.

### What API-key mode gives you

- Projects (list, create, delete), organizations (selectable when applicable),
  branches, databases, and compute endpoints.
- Asynchronous operation status (create/delete projects, branches, databases)
  with polling until the provider reports success.
- Connection diagnostics, project/branch/database selection, region display.

### Scoping guidance

- **Prefer project-scoped keys** for day-to-day work in the dashboard.
- Account keys are only needed to list/create projects across the account.
- If a key leaks, revoke it in the Neon console **now**, then rotate it. The
  dashboard also has a Disconnect button that revokes only the *dashboard
  session*; that is a separate action from revoking the Neon API key itself.

## Choosing a mode

| Need | Mode |
| --- | --- |
| Run SQL / browse one database | Database URL |
| Manage projects, branches, databases, endpoints | Neon API key |
| See health/metrics of a specific database | Database URL |
| Create databases in a branch | API key (then connect by URL if you add SQL) |

You can use both at different times; each connection is independent.

## Common questions

**Why does the URL form ask me to sign in?** Because the dashboard binds the
credential to your session and enforces authorization per user. A database URL
proves nothing about who is operating the dashboard.

**Does the URL tab list my other Neon projects?** No. It connects to exactly the
database in the URL. Project/branch/database enumeration requires API-key mode.

**Which Neon hosts are accepted?** Only `*.neon.tech` and `*.neon.build`. IP
literals and private/link-local/loopback destinations are refused, and the
resolved address is pinned for the socket while TLS is still verified against the
hostname. `sslmode=disable` is rejected — TLS verification cannot be turned off.