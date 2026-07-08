import axios from 'axios'

export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '')
}

export const tokenStore = new Map<string, string>()

export function setClientToken(serverUrl: string, token: string): void {
  tokenStore.set(normalizeUrl(serverUrl), token)
}

export function clearClientToken(serverUrl: string): void {
  tokenStore.delete(normalizeUrl(serverUrl))
}

type TokenRefreshHandler = (serverUrl: string) => Promise<string | null>

let tokenRefreshHandler: TokenRefreshHandler | null = null

export function setTokenRefreshHandler(handler: TokenRefreshHandler): void {
  tokenRefreshHandler = handler
}

const refreshMap = new Map<string, Promise<string | null>>()

export function client(baseUrl: string, token?: string) {
  const norm = normalizeUrl(baseUrl)
  const effectiveToken = token || tokenStore.get(norm)
  const headers: Record<string, string> = {}
  if (effectiveToken) headers.Authorization = `Bearer ${effectiveToken}`

  const instance = axios.create({
    baseURL: norm,
    headers,
    withCredentials: true,
  })

  instance.interceptors.response.use(
    (res) => res,
    async (error) => {
      if (error.response?.status !== 401) throw error
      if (error.config?._retry) throw error
      if (!tokenRefreshHandler) throw error

      const reqUrl: string = error.config?.url || ''
      if (reqUrl.includes('/auth/refresh')) throw error

      error.config._retry = true

      let refreshP = refreshMap.get(norm)
      if (!refreshP) {
        refreshP = tokenRefreshHandler(norm).finally(() => {
          refreshMap.delete(norm)
        })
        refreshMap.set(norm, refreshP)
      }

      const newToken = await refreshP
      if (!newToken) throw error

      tokenStore.set(norm, newToken)
      error.config.headers.Authorization = `Bearer ${newToken}`
      return instance(error.config)
    },
  )

  return instance
}

