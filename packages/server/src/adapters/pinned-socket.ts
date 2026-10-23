import net from 'node:net'
import { AppError } from '../lib/errors.js'

/**
 * Returns a `net.Socket` whose `connect()` always dials `pinnedAddress` no
 * matter what hostname the caller passes. Uses:
 *
 *  - The TCP connection therefore never resolves the user-supplied hostname a
 *    second time (DNS-rebinding defence): it goes to the IP that was validated
 *    during URL verification.
 *  - pg's TLS upgrade layer still receives the original hostname as `host` /
 *    `servername`, so SNI and certificate hostname verification are performed
 *    against the real Neon hostname — TLS verification cannot be turned off.
 */
export function createPinnedSocket(pinnedAddress: string): net.Socket {
  if (net.isIP(pinnedAddress) === 0) {
    throw new AppError({
      code: 'INTERNAL',
      message: 'Connection pin must be an IP literal',
      detail: `refusing to pin non-IP value`,
    })
  }

  const socket = new net.Socket()
  const realConnect = socket.connect.bind(socket)

  function connect(
    port: number,
    host?: string | (() => void),
    cb?: () => void,
  ): void {
    let listener: (() => void) | undefined
    if (typeof host === 'function') {
      listener = host
    } else if (typeof cb === 'function') {
      listener = cb
    }
    realConnect(port, pinnedAddress, listener)
  }

  // `socket.connect` is called by pg as `socket.connect(port, host)`. Overriding
  // on the instance lets us keep the rest of Socket API intact.
  socket.connect = connect as unknown as (typeof socket)['connect']
  return socket
}