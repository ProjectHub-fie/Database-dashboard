/**
 * Bridge between the fetch layer and the React reauth modal.
 * The fetch layer cannot import React context, so the ReauthProvider
 * registers a handler here. When any request is rejected with
 * NEEDS_REAUTH, `requestReauth` prompts for the password and resolves with
 * whether the user re-authenticated.
 */
type ReauthHandler = (message?: string) => Promise<boolean>

let handler: ReauthHandler | null = null

export function registerReauthHandler(h: ReauthHandler): void {
  handler = h
}

export function requestReauth(message?: string): Promise<boolean> {
  if (!handler) return Promise.resolve(false)
  return handler(message)
}