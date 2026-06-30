import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { Server as IoServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import type { HonoEnv } from './types';
import { registerChatHandlers } from './socket/chatHandler';
import { registerVoiceHandlers } from './socket/voiceHandler';
import { getUserInfo } from './middleware/auth';
import { COOKIE_REGEX } from './constants';
import { createLogger } from './utils/logger';

import authRoutes from './routes/auth';
import channelRoutes from './routes/channels';
import messageRoutes from './routes/messages';
import serverInfoRoutes from './routes/serverInfo';
import roleRoutes from './routes/roles';
import dmRoutes from './routes/dms';
import { groupDmRoutes, adminGroupDmRoutes } from './routes/groupDms';
import attachmentRoutes from './routes/attachments';
import mutesRoutes from './routes/mutes';
import gifRoutes from './routes/gifs';
import reactionRoutes from './routes/reactions';
import banRoutes from './routes/bans';
import auditRoutes from './routes/audit';
import searchRoutes from './routes/search';
import pinsRoutes from './routes/pins';
import threadsRoutes from './routes/threads';
import categoryRoutes from './routes/categories';
import embedRoutes from './routes/embeds';
import registryRoutes from './routes/registry';
import pollsRoutes from './routes/polls';
import webhooksRoutes from './routes/webhooks';
import { authLimiter, messageLimiter, uploadLimiter, apiLimiter } from './middleware/rateLimiter';

const log = createLogger('app');

export function createApp(httpPort: number) {
  const app = new Hono<HonoEnv>();

  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.use('*', cors({ origin: corsOrigin, credentials: corsOrigin !== '*' }));

  app.use('*', compress());

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('X-Frame-Options', 'DENY');
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.res.headers.set(
      'Permissions-Policy',
      'camera=(self), microphone=(self), geolocation=(self)',
    );
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:;",
    );
  });

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (
      path.startsWith('/api/attachments/') ||
      path === '/api/server/background' ||
      path === '/api/gifs/upload' ||
      path === '/api/gifs/pack' ||
      path === '/api/gifs/sticker-pack'
    ) {
      return next();
    }
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    const maxBodySize = parseInt(process.env.MAX_BODY_SIZE || '1048576', 10);
    if (contentLength > maxBodySize) {
      return c.json({ error: 'Request body too large' }, 413);
    }
    await next();
  });

  app.use('/api/auth/*', authLimiter);
  app.route('/api/auth', authRoutes);

  app.use('/api/channels/*', apiLimiter);
  app.route('/api/channels', channelRoutes);

  app.use('/api/messages/*', messageLimiter);
  app.route('/api/messages', messageRoutes);

  app.use('/api/server/*', apiLimiter);
  app.route('/api/server', serverInfoRoutes);

  app.use('/api/roles/*', apiLimiter);
  app.route('/api/roles', roleRoutes);

  app.use('/api/dms/*', messageLimiter);
  app.route('/api/dms', dmRoutes);

  app.use('/api/group-dms/*', messageLimiter);
  app.route('/api/group-dms', groupDmRoutes);

  app.use('/api/admin/group-dms/*', apiLimiter);
  app.route('/api/admin/group-dms', adminGroupDmRoutes);

  app.use('/api/attachments/*', uploadLimiter);
  app.route('/api/attachments', attachmentRoutes);

  app.use('/api/mutes/*', apiLimiter);
  app.route('/api/mutes', mutesRoutes);

  app.use('/api/gifs/*', uploadLimiter);
  app.route('/api/gifs', gifRoutes);

  app.use('/api/reactions/*', apiLimiter);
  app.route('/api/reactions', reactionRoutes);

  app.use('/api/bans/*', apiLimiter);
  app.route('/api/bans', banRoutes);

  app.use('/api/audit/*', apiLimiter);
  app.route('/api/audit', auditRoutes);

  app.use('/api/search/*', apiLimiter);
  app.route('/api/search', searchRoutes);

  app.use('/api/pins/*', apiLimiter);
  app.route('/api/pins', pinsRoutes);

  app.use('/api/threads/*', apiLimiter);
  app.route('/api/threads', threadsRoutes);

  app.use('/api/categories/*', apiLimiter);
  app.route('/api/categories', categoryRoutes);

  app.use('/api/embeds/*', apiLimiter);
  app.route('/api/embeds', embedRoutes);

  app.use('/api/registry/*', apiLimiter);
  app.route('/api/registry', registryRoutes);

  app.use('/api/*', apiLimiter);
  app.route('/api', pollsRoutes);
  app.route('/api', webhooksRoutes);

  app.onError((err, c) => {
    log.error('Unhandled error:', err.message || err);
    return c.json({ ok: false, error: 'Internal server error' }, 500);
  });

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      name: process.env.SERVER_NAME || 'Kizuna Server',
      version: '0.1.0',
    });
  });

  const server = serve({ fetch: app.fetch, port: httpPort });

  const httpServer = server as unknown as import('http').Server;
  const io = new IoServer(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  });

  const ioInstance: IoServer = io;

  app.use('*', async (c, next) => {
    c.set('io', ioInstance);
    await next();
  });

  io.use((socket, next) => {
    let token: string | undefined;

    const cookieHeader = socket.request.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.match(COOKIE_REGEX);
      if (match) token = match[1];
    }

    if (!token) {
      token = socket.handshake.auth?.token;
    }

    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        return next(new Error('Server configuration error'));
      }
      const payload = jwt.verify(token, secret) as { userId: string; username: string };
      const userInfo = getUserInfo(payload.userId);
      if (!userInfo) {
        return next(new Error('User not found'));
      }
      socket.data.userId = userInfo.userId;
      socket.data.username = userInfo.username;
      socket.data.role = userInfo.role;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket);
    registerVoiceHandlers(io, socket);
  });

  return { app, io, server };
}
