# Adding a provider (registry guide)

DB Horizon is a multi-provider platform. Neon is the only fully implemented and
enabled provider in this release. This document explains the provider contract so
future providers can be added without rewriting the core application.

## Architecture

```
src/
  providers/
    types.ts      Provider contract (Provider, ProviderCapabilities, …)
    registry.ts   ProviderRegistry — register + resolve by id
    neon/         Neon implementation
      provider.ts   Provider facade (registers auth methods + capabilities)
      client.ts     Neon API v2 HTTP client (official endpoints only)
      fixtures/     test fixtures
  adapters/
    sql-ident.ts  identifier quoting (shared by all PostgreSQL engines)
    postgres/     PostgreSQL engine adapter (pg driver, TLS, pooling)
```

- **Cloud-provider adapters** (control plane: projects/branches/… ) and
  **database-engine adapters** (SQL execution, schema discovery, …) are separate.
  Neon, Supabase and other hosted Postgres can share the PostgreSQL engine
  adapter while keeping their own control-plane clients.
- The shared UI works only with **normalized internal types**
  (`ConnectionStatus`, `Project`, `Branch`, `Database`, `Endpoint`, …).
  Provider-specific extras are surfaced through extension fields.
- Every provider **declares capabilities**. The UI derives sidebar entries,
  buttons, and enabled/disabled states from the connected session's capability
  list (`GET /api/capabilities`). Never hardcode provider-specific behavior in
  the client.

## The Provider interface

See `src/providers/types.ts` for the authoritative definitions. At minimum a
provider must implement:

| Member | Purpose |
| --- | --- |
| `id`, `name`, `authMethods` | identity + which auth methods it supports (`connectionString`, `apiKey`, …) |
| `buildConnection(session, creds)` | create a lazy connection handle from stored credentials |
| `status(session, handle)` | normalized `ConnectionStatus` (connected, metadata, capabilities) |
| `disconnect(session, handle)` | release all resources |
| `capabilities(session)` | declared capabilities (data.*, schema.*, control.*, import/export) |
| `validateCredentials(creds)` | pre-connect validation (e.g. verify API key against provider) |

Control-plane operations are grouped in the provider's capability namespace.
Every provider action must run **on the backend**; browser-supplied ids are
re-validated against the session's own resources on every request.

## Two authentication types

- **Direct connection credentials** (e.g. a PostgreSQL URL). The provider must
  NOT treat this as account access: no discovery or management of unrelated
  cloud resources. Neon's URL mode calls PostgreSQL only.
- **Provider API credentials** (e.g. a Neon API key). Validated against the
  official provider API; key kept in server memory only.

A provider declares which methods it supports in `authMethods`. The connect UI
shows exactly those.

## Capability declarations

Capabilities are strings of the form `<area>.<verb>`, e.g.:

```
data.read, data.write, data.sql, data.import.csv, data.export.format
schema.ddl, schema.roles, schema.grants
control.listProjects, control.createProject, control.deleteProject,
control.createBranch, control.deleteBranch, control.createDatabase,
control.deleteDatabase, control.listEndpoints, control.operations
```

Unsupported features must be **hidden or disabled with an explanation**, never
simulated. Providers must not claim capabilities they cannot honor.

## Adding a provider — steps

1. Create `src/providers/<provider>/` with a provider facade and an adapter for
   the control-plane API.
2. Register it in `src/providers/registry.ts` (`registry.register(...)`).
3. Add `src/providers/<provider>/*.test.ts` using the **provider contract test**
   (`provider-contract.test.ts` runs `assertProviderContract` against every
   registered provider).
4. Add contract tests for the control-plane client against mocked HTTP fixtures
   (mirror `api/security.test.ts` and the neon client tests for patterns).
5. Update `authMethods` + capability map; the UI picks them up automatically.
6. Add fixtures/docs in `docs/PROVIDERS.md` and the README.

## Planned providers

Supabase (managed Postgres + control-plane API) is the most natural next provider
because it shares the PostgreSQL engine adapter. It is **not implemented** in
this release and is not listed as functional anywhere in the UI; only Neon is
enabled.

## Adding a non-PostgreSQL engine (MySQL / MariaDB)

The shared layer must stay dialect-free. Concretely, the API routers
(`src/api/*`) never build SQL text: they take a `DatabaseAdapter` and pass
`{ sql, params }` through. All placeholder and quoting syntax lives in the
engine adapter, declared through `EngineDialect` in `providers/types.ts`
(`placeholder`, `quoteIdentifier`, `defaultPort`, `schemaModel`).

That boundary is enforced by `adapters/engine-dialect.test.ts`, which fails if
`$n` placeholder construction appears anywhere outside an adapter.

A MySQL adapter (`mysql2`) must therefore:

| Concern | PostgreSQL (current) | MySQL / MariaDB |
| --- | --- | --- |
| Placeholder | `$1`, `$2`, … | `?` (positional, in order) |
| Identifier quoting | `"name"` | `` `name` `` |
| Default port | 5432 | 3306 |
| Schema model | `schemaModel: 'namespace'` (schema.table) | `schemaModel: 'database'` (database = schema; query `information_schema`) |
| Catalog discovery | `pg_catalog` | `information_schema` |
| Statement timeout | `SET statement_timeout` | `SET SESSION max_execution_time` |
| Cancel a query | `pg_cancel_backend(pid)` | `KILL QUERY <connection_id>` |
| TLS | `ssl` with CA + `rejectUnauthorized` | `ssl: { rejectUnauthorized: true, ca }` |
| Row identity | primary key / ctid-free unique key | primary key (MySQL has no `ctid`) |

Requirements before MySQL can be enabled:

1. The adapter declares `dialect` with `kind: 'mysql'` and `?` placeholders, and
   never emits `$n`.
2. SSRF/TLS rules in `security/netlib.ts` are extended with an explicit,
   admin-controlled host policy — MySQL destinations are not Neon hosts, so the
   current deny-by-default rule rejects them (that is intentional and must not be
   weakened into arbitrary-host allowlisting).
3. Contract tests pass, including a test proving `$n` is never sent to MySQL.
4. Only then add the provider to the registry and expose it in the UI.

Until all four are done the engine must not appear as selectable.

## Testing rules

- External Neon services (API responses) are mocked **only in automated tests**.
- The real application uses genuine Neon API v2 responses and real PostgreSQL
  connections.
- Every provider must pass the contract tests before it can be registered.