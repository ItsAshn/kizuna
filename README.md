# Kizuna

A self-hosted Discord alternative. You self-host the server and connect with the desktop client.

## Projects

| Directory | Description | Tech |
|-----------|------------|------|
| `apps/server/` | Backend API + WebSocket + Voice server | Node.js, Hono, Socket.IO, mediasoup, better-sqlite3 |
| `apps/desktop/` | Desktop client | Tauri v2, React, Vite, Tailwind |
| `packages/shared/` | Shared TypeScript types and API client | TypeScript |

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [pnpm](https://pnpm.io/) v9+
- For desktop development: [Rust](https://rustup.rs/) (for Tauri)
- For Docker hosting: [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) v2+

## Quick Start

```bash
# Install all dependencies
pnpm install

# Start server in development mode
pnpm dev:server

# Start desktop client in development mode
pnpm dev:desktop

# Run both concurrently
pnpm dev
```

## Hosting with Docker

```bash
# Pull the image
docker pull ghcr.io/itsashn/kizuna:latest

# Or build locally
docker compose up -d
```

## Environment Variables

See `apps/server/.env.example` for full configuration reference.

## License

MIT
