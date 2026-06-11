import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { Server as IoServer } from 'socket.io'
import jwt from 'jsonwebtoken'
import { registerChatHandlers } from './socket/chatHandler'
import { registerVoiceHandlers } from './socket/voiceHandler'
import { getUserInfo } from './middleware/auth'

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

  const corsOrigin = process.env.CORS_ORIGIN || '*'
  app.use('*', cors({ origin: corsOrigin }))

  app.use('*', async (c, next) => {
    await next()
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('X-Frame-Options', 'DENY')
    c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    c.res.headers.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:;")
  })

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/attachments/') || path === '/api/server/background') {
      return next()
    }
    const contentLength = parseInt(c.req.header('content-length') || '0', 10)
    const maxBodySize = parseInt(process.env.MAX_BODY_SIZE || '1048576', 10)
    if (contentLength > maxBodySize) {
      return c.json({ error: 'Request body too large' }, 413)
    }
    await next()
  })

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

  app.route('/api/attachments', attachmentRoutes)

  // Global error handler
  app.onError((err, c) => {
    console.error('[server] Unhandled error:', err.message || err)
    return c.json({ error: 'Internal server error' }, 500)
  })

  // Health check
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      name: process.env.SERVER_NAME || 'Kizuna Server',
      version: '0.1.0',
    })
  })

  const server = serve({ fetch: app.fetch, port: httpPort })

  // Set up Socket.IO on top of the same server
  const httpServer = server as unknown as import('http').Server
  const io = new IoServer(httpServer, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  })

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
    if (!token) {
      return next(new Error('Authentication required'))
    }
    try {
      const secret = process.env.JWT_SECRET
      if (!secret) {
        return next(new Error('Server configuration error'))
      }
      const payload = jwt.verify(token, secret) as { userId: string; username: string }
      const userInfo = getUserInfo(payload.userId)
      if (!userInfo) {
        return next(new Error('User not found'))
      }
      socket.data.userId = userInfo.userId
      socket.data.username = userInfo.username
      socket.data.role = userInfo.role
      next()
    } catch {
      next(new Error('Invalid or expired token'))
    }
  })

  ioInstance = io

  io.on('connection', (socket) => {
    registerChatHandlers(io, socket)
    registerVoiceHandlers(io, socket)
  })

  return { app, io, server }
}
