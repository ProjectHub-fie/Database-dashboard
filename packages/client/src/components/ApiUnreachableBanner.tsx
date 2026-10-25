import { AlertTriangle } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'

/**
 * Shown when `/api` returned a platform error page instead of the API's JSON
 * envelope — almost always a deployment whose API function was never built, so
 * every write "fails with 404" for no visible reason. Rendering the cause once,
 * app-wide, beats decoding an opaque status code in each panel.
 */
export function ApiUnreachableBanner(): React.JSX.Element | null {
  const { apiUnreachable } = useAuth()
  if (!apiUnreachable) return null
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">This deployment cannot reach the API.</p>
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          Requests to <code className="font-mono">/api</code> are answered by the hosting platform
          rather than the dashboard API, so connecting and querying cannot work. The usual cause is
          a Vercel project whose Root Directory is not the repository root, which stops the{' '}
          <code className="font-mono">api/[...path]</code> proxy function from being built.
        </p>
        <p className="mt-1 text-amber-800 dark:text-amber-300">
          Verify with <code className="font-mono">curl -i &lt;deployment&gt;/api/healthz</code>: it
          must return JSON <code className="font-mono">{'{"ok":true}'}</code>, not an HTML page.
        </p>
      </div>
    </div>
  )
}
