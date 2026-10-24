/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the API when the static bundle is deployed separately
   * (for example on Vercel while the API runs on another host). Leave empty for
   * same-origin deployments. Never put credentials in this variable.
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
