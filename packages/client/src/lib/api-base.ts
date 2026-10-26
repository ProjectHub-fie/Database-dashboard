/**
 * Optional API origin for split deployments (static frontend on Vercel, API
 * elsewhere). Empty means same-origin, which is the default. This is a public
 * URL only — credentials are never configured client-side.
 *
 * Lives in its own module so the link monitor can probe `/api/healthz` without
 * importing the request layer (which would be a cycle).
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '')
