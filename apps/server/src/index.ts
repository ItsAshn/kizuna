import 'dotenv/config'
import path from 'node:path'
import fs from 'node:fs'
import { createApp } from './app'
import { initDb, closeDb } from './db'
import { createWorker, closeWorker } from './media'
import { loadConfig, validateJwtSecret } from './config'
import { openPorts, registerShutdownHook } from './services/upnp'
import { resolvePublicAddress, startIpWatcher } from './services/publicAddress'

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

  console.log('[✓] Configuration validated')

  try {
    initDb()
    console.log('[✓] Database initialized')
  } catch (err: any) {
    console.error('[!] Failed to initialize database:', err.message)
    process.exit(1)
  }

  registerShutdownHook()

  console.log(`[i] Configuring network (UPnP: ${process.env.UPNP_ENABLED !== 'false' ? 'enabled' : 'disabled'})...`)
  await openPorts({ httpPort: PORT, rtcMinPort: RTC_MIN, rtcMaxPort: RTC_MAX })

  console.log('[i] Resolving public address...')
  try {
    await resolvePublicAddress()
    console.log(`[✓] Public address: ${process.env.PUBLIC_ADDRESS || 'auto-detected'}`)
  } catch (err: any) {
    console.warn(`[!] Could not resolve public address: ${err.message}`)
  }
  startIpWatcher()

  console.log('[i] Starting voice server...')
  try {
    await createWorker()
    console.log('[✓] Media worker started')
  } catch (err: any) {
    console.error('[!] Failed to start mediasoup worker:', err.message)
  }

  const { server } = createApp(PORT)

  console.log(`\n[✓] Server "${config.SERVER_NAME}" running`)
  console.log(`[i] HTTP:       http://localhost:${PORT}`)
  console.log(`[i] Health:     http://localhost:${PORT}/health`)
  console.log(`[i] Voice:      UDP ${process.env.RTC_MIN_PORT}-${process.env.RTC_MAX_PORT}`)
  console.log('')
  console.log('Connect with the Kizuna desktop client.')
  console.log('Press Ctrl+C to stop.\n')

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`)
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
