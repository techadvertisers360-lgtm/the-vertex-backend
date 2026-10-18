import { createServer } from 'node:http';
import { env } from './config/env';
import { createApp } from './app';
import { logger } from './lib/misc';
import { prisma } from './lib/prisma';
import { attachRealtime } from './realtime/server';

const app = createApp();
const server = createServer(app);
const realtime = attachRealtime(server);

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT, tz: env.APP_TIMEZONE }, 'Vertex Health API listening (REST + Socket.IO)');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down API');
  await realtime.close();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
