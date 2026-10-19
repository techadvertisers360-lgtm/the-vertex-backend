import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/misc';
import { ACCESS_COOKIE, verifyAccessToken } from '../auth/tokens';
import { resolveSession, type AuthUser } from '../middleware/auth';
import { roleRoom, userRoom } from '../services/realtime';
import { pruneRealtime, relayPending, type RealtimeTransport } from './relay';

interface SocketData {
  user: AuthUser;
  tv: number;
}

export interface RealtimeHandle {
  io: Server;
  /** Relay committed realtime_events once (exposed for tests). */
  relayOnce: () => Promise<number>;
  /** Re-validate every connected socket's session once (exposed for tests). */
  revalidateOnce: () => Promise<number>;
  close: () => Promise<void>;
}

/**
 * Socket.IO server (D-024). Authenticates the handshake with the same httpOnly session cookie as the REST API,
 * puts each socket in its own `user:<id>` room plus `role:<ROLE>`, and relays the realtime outbox.
 * Sockets are re-validated periodically and dropped when the session/user is revoked or disabled.
 */
export function attachRealtime(httpServer: HttpServer, opts: { relayMs?: number; revalidateMs?: number } = {}): RealtimeHandle {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: env.FRONTEND_ORIGIN.split(','), credentials: true },
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const token = cookies[ACCESS_COOKIE];
      const claims = token ? verifyAccessToken(token) : null;
      if (!claims) return next(new Error('UNAUTHENTICATED'));
      const user = await resolveSession(claims.sub, claims.sid, claims.tv);
      (socket.data as SocketData) = { user, tv: claims.tv };
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const { user } = socket.data as SocketData;
    await socket.join([userRoom(user.id), roleRoom(user.role)]);
    const unread = await prisma.notification.count({ where: { recipientId: user.id, readAt: null } });
    socket.emit('hello', { userId: user.id, role: user.role, unreadCount: unread });
  });

  const transport: RealtimeTransport = {
    name: 'socketio',
    async send(events) {
      for (const e of events) {
        io.to(e.room).emit(e.event, e.payload);
        if (e.event === 'session:revoked') io.in(e.room).disconnectSockets(true);
      }
    },
  };
  let relaying = false;
  async function relayOnce(): Promise<number> {
    if (relaying) return 0;
    relaying = true;
    try {
      return await relayPending(transport);
    } finally {
      relaying = false;
    }
  }

  async function revalidateOnce(): Promise<number> {
    let dropped = 0;
    for (const socket of io.of('/').sockets.values()) {
      const d = socket.data as SocketData;
      try {
        await resolveSession(d.user.id, d.user.sessionId, d.tv);
      } catch {
        socket.emit('session:revoked', {});
        socket.disconnect(true);
        dropped += 1;
      }
    }
    return dropped;
  }

  const relayTimer = setInterval(() => void relayOnce().catch((err) => logger.error({ err }, 'realtime relay failed')), opts.relayMs ?? 1000);
  const revalidateTimer = setInterval(() => void revalidateOnce().catch((err) => logger.error({ err }, 'socket revalidation failed')), opts.revalidateMs ?? 60_000);
  // Delivered events are ephemeral; prune after a day.
  const pruneTimer = setInterval(() => void pruneRealtime().catch(() => undefined), 3600_000);

  return {
    io,
    relayOnce,
    revalidateOnce,
    close: async () => {
      clearInterval(relayTimer);
      clearInterval(revalidateTimer);
      clearInterval(pruneTimer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
