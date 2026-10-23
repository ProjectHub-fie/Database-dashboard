import type { Express, Request, Response, NextFunction } from 'express'

type Handler = (req: Request, res: Response, next: NextFunction) => unknown

/**
 * Express 4 does not forward rejected promises from async middleware/handlers
 * to the error middleware — an async throw leaves the request hanging until a
 * client-side timeout. This walks the already-registered router stack and
 * wraps every non-error handler so a returned promise forwards its rejection to
 * `next()`.
 */
export function forwardAsyncErrors(app: Express): void {
  const root = (app as unknown as { _router?: { stack: unknown[] } })._router
  if (!root) return

  const visit = (layers: unknown[]): void => {
    for (const layer of layers as Array<Record<string, any>>) {
      if (layer.route && Array.isArray(layer.route.stack)) {
        for (const route of layer.route.stack as Array<Record<string, any>>) {
          const fn = route.handle as Handler | undefined
          if (typeof fn === 'function' && fn.length !== 4) {
            route.handle = wrap(fn)
          }
        }
      } else if (typeof layer.handle === 'function' && Array.isArray(layer.handle?.stack)) {
        // Nested router mounted via app.use('/x', router)
        visit(layer.handle.stack)
      } else if (typeof layer.handle === 'function' && layer.handle?.length !== 4) {
        const fn = layer.handle as Handler
        layer.handle = wrap(fn)
      }
    }
  }

  visit(root.stack)
}

function wrap(fn: Handler): Handler {
  return function asyncWrapped(req: Request, res: Response, next: NextFunction) {
    try {
      const maybePromise = fn(req, res, next)
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
        ;(maybePromise as Promise<unknown>).catch((err) => next(err))
      }
    } catch (err) {
      next(err)
    }
  }
}