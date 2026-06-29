import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { createApp } from './app'
import { initDb, closeDb } from './db'
import { createWorker, closeWorker } from './media'
import { loadConfig, validateJwtSecret } from './config'
import { setTaggingEnabled } from './media/tagGenerator'
import { applyConfig } from './services/spamFilter'
import { openPorts, upnpClient, getMappedPorts } from './services/upnp'
import { resolvePublicAddress, startIpWatcher } from './services/publicAddress'
import { startHeartbeat } from './heartbeat'
import { startRegistryCleanup } from './routes/registry'
import { startAuditLogCleanup } from './routes/audit'
import { startOrphanCleanup } from './routes/attachments'
import { getServerInfo } from './routes/serverInfo'

function printBanner(): void {
  console.log(`
 ╭───────────────────────────────────────────────────────────╮
 │                                                           │
 │   Kizuna Server                                           │
 │                                                           │
 ╰───────────────────────────────────────────────────────────╯
`)
}

function checkEnvFile(): void {
  if (process.env.JWT_SECRET) return

  if (!fs.existsSync(path.join(process.cwd(), '.env'))) {
    console.error(
      '\n[!] No .env file found.\n' +
      '    Copy .env.example to .env and edit it.\n'
    )
    process.exit(1)
  }
}

const PORT = parseInt(process.env.SERVER_PORT || '5000', 10)
const RTC_MIN = parseInt(process.env.RTC_MIN_PORT || '40000', 10)
const RTC_MAX = parseInt(process.env.RTC_MAX_PORT || '40099', 10)

async function start(): Promise<void> {
  printBanner()
  checkEnvFile()

  const config = loadConfig()
  validateJwtSecret(config)
  applyConfig({
    rateMax: config.SPAM_RATE_MAX,
    rateWindowMs: config.SPAM_RATE_WINDOW_MS,
    channelRateMax: config.SPAM_CHANNEL_RATE_MAX,
    channelRateWindowMs: config.SPAM_CHANNEL_RATE_WINDOW_MS,
    mentionMax: config.SPAM_MENTION_MAX,
    mentionWindowMs: config.SPAM_MENTION_WINDOW_MS,
    duplicateWindowMs: config.SPAM_DUPLICATE_WINDOW_MS,
    autoMuteDurationMs: config.SPAM_AUTO_MUTE_DURATION_MS,
    maxViolations: config.SPAM_MAX_VIOLATIONS,
  })
  setTaggingEnabled(config.AUTO_TAGGING_ENABLED)
  if (config.AUTO_TAGGING_ENABLED) {
    console.log('[i] Auto-tagging is enabled. Call POST /api/gifs/load-tagger or use the Server Settings UI to load the CLIP model when ready.')
  }

  console.log('[✓] Configuration validated')

  try {
    initDb()
    console.log('[✓] Database initialized')
  } catch (err: unknown) {
    console.error('[!] Failed to initialize database:', err instanceof Error ? err.message : err)
    process.exit(1)
  }

  startAuditLogCleanup()
  startOrphanCleanup()
  console.log('[i] Scheduled cleanup jobs started')

  console.log(`[i] Configuring network (UPnP: ${process.env.UPNP_ENABLED !== 'false' ? 'enabled' : 'disabled'})...`)
  await openPorts({ httpPort: PORT, rtcMinPort: RTC_MIN, rtcMaxPort: RTC_MAX })

  console.log('[i] Resolving public address...')
  try {
    await resolvePublicAddress()
    console.log(`[✓] Public address: ${process.env.PUBLIC_ADDRESS || 'auto-detected'}`)
  } catch (err: unknown) {
    console.warn(`[!] Could not resolve public address: ${err instanceof Error ? err.message : err}`)
  }
  startIpWatcher()

  console.log('[i] Starting voice server...')
  try {
    await createWorker()
    console.log('[✓] Media worker started')
  } catch (err: unknown) {
    console.error('[!] Failed to start mediasoup worker:', err instanceof Error ? err.message : err)
  }

  const { server: _server, io } = createApp(PORT)

  if (config.IS_REGISTRY) {
    startRegistryCleanup()
    console.log('[i] Registry enabled')
  }

  if (config.IS_PUBLIC) {
    startHeartbeat(
      config,
      () => io.engine.clientsCount,
      () => {
        const info = getServerInfo()
        return {
          name: info.name,
          description: info.description,
          passwordProtected: info.passwordProtected,
          icon: info.icon,
        }
      },
    )
    console.log('[i] Public listing enabled')
  }

  console.log(`\n[✓] Server "${config.SERVER_NAME}" running`)
  console.log(`[i] HTTP:       http://localhost:${PORT}`)
  console.log(`[i] Health:     http://localhost:${PORT}/health`)
  console.log(`[i] Voice:      UDP ${process.env.RTC_MIN_PORT}-${process.env.RTC_MAX_PORT}`)
  console.log('')
  console.log('Connect with the Kizuna desktop client.')
  console.log('Press Ctrl+C to stop.\n')

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`)
    for (const mapping of getMappedPorts()) {
      try { upnpClient.portUnmapping({ public: mapping.public }, () => {}) } catch {}
    }
    closeDb()
    await closeWorker()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

start().catch((err: Error) => {
  console.error('\n[!] Server failed to start:', err.message)
  process.exit(1)
})
