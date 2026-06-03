import * as mediasoup from 'mediasoup'
import type { types as mediasoupTypes } from 'mediasoup'

let worker: mediasoupTypes.Worker | null = null

export async function createWorker(): Promise<mediasoupTypes.Worker> {
  if (worker) return worker

  worker = await mediasoup.createWorker({
    logLevel: (process.env.MEDIASOUP_LOG_LEVEL || 'warn') as mediasoupTypes.WorkerLogLevel,
    rtcMinPort: parseInt(process.env.RTC_MIN_PORT || '40000', 10),
    rtcMaxPort: parseInt(process.env.RTC_MAX_PORT || '40099', 10),
  })

  worker.on('died', () => {
    console.error('[mediasoup] Worker died, exiting in 2s...')
    setTimeout(() => process.exit(1), 2000)
  })

  return worker
}

export function getWorker(): mediasoupTypes.Worker | null {
  return worker
}

export async function closeWorker(): Promise<void> {
  if (worker) {
    await worker.close()
    worker = null
  }
}
