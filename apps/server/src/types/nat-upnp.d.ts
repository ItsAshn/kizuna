declare module 'nat-upnp' {
  interface Client {
    portMapping(options: {
      public: number | { port: number; host?: string }
      private: number | { port: number; host?: string }
      ttl: number
      protocol?: 'tcp' | 'udp'
    }, callback: (err: Error | null) => void): void

    portUnmapping(options: { public: number }, callback: (err: Error | null) => void): void

    externalIp(callback: (err: Error | null, ip: string) => void): void
  }

  function createClient(): Client
  export default { createClient }
}
