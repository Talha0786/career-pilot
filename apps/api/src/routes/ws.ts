import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import type { ConnectionHub } from '../ws/hub.js';

export function registerWsRoutes(app: FastifyInstance, deps: { hub: ConnectionHub }): void {
  app.get('/ws', { preHandler: requireAuth, websocket: true }, (socket, request) => {
    deps.hub.register(request.actor!.userId, socket);
  });
}
