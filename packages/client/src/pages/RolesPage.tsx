import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { api } from '../lib/api'
import { RoleInfo, GrantInfo } from '../lib/types'
import { Card, Badge, EmptyState, Input, Skeleton, Table } from '../components/ui'
import { KeyRound, Users } from 'lucide-react'

export function RolesPage() {
  const auth = useAuth()
  const [roles, setRoles] = useState<RoleInfo[]>([])
  const [grants, setGrants] = useState<GrantInfo[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [filter, setFilter] = useState('')

  const accountOnly = auth.connection?.accountOnly === true

  useEffect(() => {
    if (accountOnly) return
    Promise.all([
      api.get<{ roles: RoleInfo[] }>('/api/data/roles').catch(() => null),
      api.get<{ grants: GrantInfo[] }>('/api/data/grants').catch(() => null),
    ])
      .then(([r, g]) => {
        if (r) setRoles(r.roles)
        if (g) setGrants(g.grants)
        setState('ready')
      })
      .catch(() => setState('error'))
  }, [accountOnly])

  if (accountOnly) {
    return <EmptyState icon={<Users className="h-10 w-10" />} title="Roles need a database connection" description="Connect with a database URL to inspect PostgreSQL roles and grants." />
  }

  const filtered = grants.filter((g) =>
    filter ? `${g.role} ${g.schema ?? ''} ${g.objectName ?? ''} ${g.privilege}`.toLowerCase().includes(filter.toLowerCase()) : true,
  )

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Roles & Access</h1>
        <Badge tone="amber">read-only introspection</Badge>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Permissions shown here reflect the actual PostgreSQL roles and grants on the connected database. The dashboard cannot grant more than your role allows.
      </p>

      {state === 'loading' && <Skeleton className="h-40 w-full" />}
      {state === 'error' && (
        <EmptyState title="Roles unavailable" description="Your connected role cannot inspect roles and grants. PostgreSQL returned a permissions error." />
      )}
      {state === 'ready' && (
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
              <Users className="h-4 w-4 text-indigo-500" /> PostgreSQL roles
            </h2>
            <Table
              headers={['Role', 'Attributes', 'Member of']}
              rows={roles.map((r) => [
                <span key="n" className="font-mono">{r.name}</span>,
                <span key="a" className="flex flex-wrap gap-1">
                  {r.attributes.map((a) => (
                    <Badge key={a} tone={/super|create|bypass/i.test(a) ? 'amber' : 'slate'}>{a}</Badge>
                  ))}
                </span>,
                <span key="m" className="font-mono text-xs text-slate-400">{r.memberOf.join(', ') || '—'}</span>,
              ])}
            />
          </Card>

          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
                <KeyRound className="h-4 w-4 text-amber-500" /> Grants
              </h2>
              <div className="w-64">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter grants…" />
              </div>
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <Table
                headers={['Role', 'Schema', 'Object', 'Privilege', 'Grantable']}
                rows={filtered.slice(0, 300).map((g) => [
                  <span key="r" className="font-mono">{g.role}</span>,
                  <span key="s" className="font-mono">{g.schema ?? '—'}</span>,
                  <span key="o" className="font-mono">{g.objectName ?? g.objectType ?? '—'}</span>,
                  <Badge key="p" tone="indigo">{g.privilege}</Badge>,
                  <span key="g">{g.grantable ? 'yes' : 'no'}</span>,
                ])}
                empty={`${filter ? `No grants match "${filter}".` : 'No grants are visible to this role.'}`}
              />
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}