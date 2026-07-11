import type { WebSocket } from 'ws';
import type { JobEmbeddedEvent } from '@careerpilot/contracts';

/**
 * In-process registry of live `/ws` connections, keyed by user id. Fine for
 * a single API instance (M2's deployment shape — apps/03-folder-structure
 * doesn't scale the API horizontally yet); a multi-instance future would
 * need this to become "subscribe directly to the Redis channel per
 * connection" instead of routing through one process's memory.
 */
export class ConnectionHub {
  private byUser = new Map<string, Set<WebSocket>>();

  register(userId: string, socket: WebSocket): void {
    let sockets = this.byUser.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.byUser.set(userId, sockets);
    }
    sockets.add(socket);

    socket.on('close', () => {
      sockets!.delete(socket);
      if (sockets!.size === 0) this.byUser.delete(userId);
    });
  }

  /** Fans out ONLY to the owning user's connections — never a global broadcast. */
  sendToUser(userId: string, event: JobEmbeddedEvent): void {
    const sockets = this.byUser.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(event);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  get connectedUserCount(): number {
    return this.byUser.size;
  }
}
