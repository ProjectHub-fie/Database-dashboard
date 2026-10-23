# Connecting to Neon

## Database URL mode

A Neon pooled or unpooled connection string looks like:

```text
postgres://neondb_owner:<password>@ep-<endpoint>.us-east-2.aws.neon.tech/neondb?sslmode=require
```

Paste it into the *Database URL* tab on the Connect screen.

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