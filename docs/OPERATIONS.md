# Deployment, credential rotation, and incident response

## Deployment

### 1. Build

```bash
npm ci
npm run build
```

`packages/client/dist` is produced; the production server serves it from
`packages/server` → `../client/dist`.

### 2. Environment

Set every variable from `.env.example`. Minimum for production:

```bash
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
COOKIE_SECRET=<64+ random bytes, e.g. openssl rand -base64 48>
CORS_ORIGINS=<your dashboard origin, e.g. https://db.example.com>
ADMIN_USERNAME=admin
ADMIN_INITIAL_PASSWORD=<strong, ≥ 12 chars>
TRUST_PROXY=true       # only when behind a TLS-terminating proxy
```

If you use a file-backed store, configure a persistent `dataDir` (the server
stores users/sessions/audit in `packages/server/data/db-horizon.sqlite` by
default).

### 3. Run behind TLS

Run the Node server bound to `127.0.0.1` and terminate TLS at a reverse proxy
(Caddy/nginx/Traefik). Set `TRUST_PROXY=true` so the proxy IP is trusted for
rate-limiting and secure cookies. Verified example with Caddy:

```caddyfile
db.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Then `Secure` cookies apply (session cookie is marked secure in production when
the request comes over HTTPS).

### 4. Health check

`GET /healthz` returns `{"ok":true}` without authentication.

## Credential rotation

### PostgreSQL role password (database URL mode)

1. In the Neon console, reset the password for the role.
2. Reconnect in the dashboard with the new URL (or wait for the session to
   expire — old sessions are closed on disconnect/idle).
3. Update any other systems that hold the old URL.

### Neon API key

1. **Revoke the old key** in Neon console (API keys page).
2. Create a replacement key (prefer project-scoped).
3. Reconnect the dashboard; the new key is validated against the Neon API before
   the session is created.
4. Audit `/api/audit` (or server logs) for usage before the revocation time stamp
   to estimate what was touched.

### Dashboard session

- Disconnect (revokes the dashboard session + closes the connection pool).
- Sign-out (revokes the session server-side).
- Idle expiry (default 30 min) or TTL (default 8 h).

## Incident response

If you suspect a credential leaked (public gist, commit, chat log, compromised
host):

1. **Contain** — revoke the affected credential at the provider *before* doing
   anything else:
   - Neon API key: revoke in console now.
   - PostgreSQL role password: reset it now (kills open connections using old
     password only if Neon enforces re-auth; assume the worst).
2. **Assess blast radius**
   - Check Neon activity logs for the project/account.
   - Check dashboard audit events (Security page / `/api/audit`) and server logs
     for connections around the leak window.
   - Note whether the URL was pooled or unpooled and which database it reached.
3. **Remediate**
   - Rotate credentials per above.
   - If the leak included API keys, review and revoke any integrations created
     with them (webhooks, branches from other accounts, exposed compute
     endpoints).
   - Consider enabling Neon per-IP rules / VPC peering if you have heavy exposure
     and want to restrict endpoint reachability.
4. **Harden**
   - Enforce password manager policy for the admin password; consider SSO if
     available.
   - Use project-scoped API keys.
   - Set a short `IDLE_SESSION_TTL_MS` for shared machines.

## Backups / point-in-time restore

- Exports from the dashboard are **snapshots of table data**, not Neon backups.
- Real Neon protection comes from Neon's own point-in-time restore (PITR) and
  branched storage. The dashboard lists branches and can create them; it cannot
  (and does not claim to) create a PITR backup through a database URL.
- To protect a project at the provider level, use Neon console/CLI PITR and test
  restore into a branch before relying on it.