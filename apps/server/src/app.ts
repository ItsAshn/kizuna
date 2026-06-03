import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { Server as IoServer } from 'socket.io'
import { registerChatHandlers } from './socket/chatHandler'
import { registerVoiceHandlers } from './socket/voiceHandler'

import authRoutes from './routes/auth'
import channelRoutes from './routes/channels'
import messageRoutes from './routes/messages'
import serverInfoRoutes from './routes/serverInfo'
import roleRoutes from './routes/roles'
import dmRoutes from './routes/dms'
import attachmentRoutes from './routes/attachments'
import { authLimiter, messageLimiter, uploadLimiter, apiLimiter } from './middleware/rateLimiter'

export function createApp(httpPort: number) {
  const app = new Hono()

  app.use('*', cors())

  // Pass io to request context via middleware
  let ioInstance: IoServer | null = null

  app.use('*', async (c, next) => {
    c.set('io' as never, ioInstance as never)
    await next()
  })

  // Routes
  app.use('/api/auth/*', authLimiter as never)
  app.route('/api/auth', authRoutes)

  app.use('/api/channels/*', apiLimiter as never)
  app.route('/api/channels', channelRoutes)

  app.use('/api/messages/*', messageLimiter as never)
  app.route('/api/messages', messageRoutes)

  app.use('/api/server/*', apiLimiter as never)
  app.route('/api/server', serverInfoRoutes)

  app.use('/api/roles/*', apiLimiter as never)
  app.route('/api/roles', roleRoutes)

  app.use('/api/dms/*', messageLimiter as never)
  app.route('/api/dms', dmRoutes)

  app.use('/api/attachments/*', uploadLimiter as never)
  app.route('/api/attachments', attachmentRoutes)

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      name: process.env.SERVER_NAME || 'Kizuna Server',
      version: '0.1.0',
      passwordProtected: !!(process.env.SERVER_PASSWORD && process.env.SERVER_PASSWORD.trim()),
    })
  })

  const server = serve({ fetch: app.fetch, port: httpPort })

  // Set up Socket.IO on top of the same server
  const httpServer = server as unknown as import('http').Server
  const io = new IoServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  })

  ioInstance = io

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket)
    registerVoiceHandlers(io, socket)
  })

  return { app, io, server }
}
