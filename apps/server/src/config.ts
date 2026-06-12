import { z } from 'zod'

const envSchema = z.object({
  SERVER_PORT: z.coerce.number().int().positive().default(5000),
  SERVER_NAME: z.string().default('Kizuna Server'),
  SERVER_DESCRIPTION: z.string().default('A self-hosted Kizuna community'),
  SERVER_URL: z.string().optional().default(''),
  SERVER_PASSWORD: z.string().optional().default(''),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  SERVER_DB_PATH: z.string().default('./server.db'),
  MEDIASOUP_LISTEN_IP: z.string().default('0.0.0.0'),
  PUBLIC_ADDRESS: z.string().optional().default(''),
  RTC_MIN_PORT: z.coerce.number().int().positive().default(40000),
  RTC_MAX_PORT: z.coerce.number().int().positive().default(40099),
  MEDIASOUP_LOG_LEVEL: z.enum(['debug', 'warn', 'error', 'none']).default('warn'),
  AUDIO_BITRATE_KBPS: z.coerce.number().int().positive().default(64),
  STUN_SERVERS: z.string().default('stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302'),
  TURN_ENABLED: z.coerce.boolean().default(false),
  TURN_URL: z.string().optional().default(''),
  TURN_USERNAME: z.string().optional().default(''),
  TURN_PASSWORD: z.string().optional().default(''),
  UPNP_ENABLED: z.coerce.boolean().default(true),
  IP_CHECK_INTERVAL: z.coerce.number().int().positive().default(300),
  IS_PUBLIC: z.coerce.boolean().default(false),
  UPLOADS_DIR: z.string().optional().default(''),
  GIFS_DIR: z.string().optional().default(''),
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(10485760),
  MAX_GIF_SIZE: z.coerce.number().int().positive().default(52428800),
  MAX_PACK_SIZE: z.coerce.number().int().positive().default(15728640),
  MAX_BODY_SIZE: z.coerce.number().int().positive().default(1048576),
})

export type EnvConfig = z.infer<typeof envSchema>

export function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('\n[!] Configuration errors:')
    for (const issue of result.error.issues) {
      console.error(`    - ${issue.path.join('.')}: ${issue.message}`)
    }
    console.error('')
    process.exit(1)
  }
  return result.data
}

export function validateJwtSecret(config: EnvConfig): void {
  if (config.JWT_SECRET === 'change_this_to_a_long_random_secret') {
    console.error(
      '\n[!] JWT_SECRET is using the default placeholder.\n' +
      '    Generate one with: openssl rand -hex 64\n' +
      '    Then set it in your .env file.\n',
    )
    process.exit(1)
  }
}
