import natUpnp from 'nat-upnp'

const client = natUpnp.createClient()
export const upnpClient: ReturnType<typeof natUpnp.createClient> = client
const mappedPorts: { public: number; private: { host: string; port: number }; ttl: number }[] = []
export function getMappedPorts() { return mappedPorts }

export async function openPorts(options: {
  httpPort: number
  rtcMinPort: number
  rtcMaxPort: number
}): Promise<{ effectiveRtcMin: number; effectiveRtcMax: number }> {
  if (process.env.UPNP_ENABLED === 'false') {
    console.log('[i] UPnP disabled, skipping port mapping')
    return { effectiveRtcMin: options.rtcMinPort, effectiveRtcMax: options.rtcMaxPort }
  }

  try {
    const externalIp = await new Promise<string>((resolve, reject) => {
      client.externalIp((err: Error | null, ip: string) => {
        if (err) reject(err)
        else resolve(ip)
      })
    })
    console.log(`[i] UPnP gateway found: ${externalIp}`)

    // Map HTTP port
    await new Promise<void>((resolve, _reject) => {
      client.portMapping({
        public: options.httpPort,
        private: options.httpPort,
        ttl: 0, // indefinite
      }, (err: Error | null) => {
        if (err) console.warn(`[UPnP] HTTP port ${options.httpPort} mapping failed:`, err.message)
        else console.log(`[UPnP] Mapped TCP ${options.httpPort}`)
        resolve()
      })
    })

    // Map RTC port range (UDP)
    for (let port = options.rtcMinPort; port <= options.rtcMaxPort; port++) {
      await new Promise<void>((resolve) => {
        client.portMapping({
          public: { port },
          private: { port },
          ttl: 0,
          protocol: 'udp',
        }, (err: Error | null) => {
          if (err) {
            // Stop mapping if we hit the limit
          }
          mappedPorts.push({ public: port, private: { host: '', port }, ttl: 0 })
          resolve()
        })
      })
    }
    console.log(`[UPnP] Mapped UDP ${options.rtcMinPort}-${options.rtcMaxPort}`)
  } catch (err: unknown) {
    console.warn(`[i] UPnP not available: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { effectiveRtcMin: options.rtcMinPort, effectiveRtcMax: options.rtcMaxPort }
}

export function registerShutdownHook(): void {
  const cleanup = () => {
    for (const mapping of mappedPorts) {
      client.portUnmapping({ public: mapping.public }, () => {})
    }
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)
}
