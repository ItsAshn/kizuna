---
title: Development
description: Set up a development environment for Kizuna, the open-source Discord alternative. Tech stack, monorepo structure, and build instructions.
---

# Development

## Prerequisites

- **Node.js** 22+
- **pnpm** 9.15+
- **Rust** (for the desktop client)
- System dependencies for Tauri on your platform

## Setup

```bash
git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
pnpm install
```

## Running

### Server

```bash
pnpm --filter @kizuna/server dev
```

The server starts on `http://localhost:3000` by default (configurable via `PORT` in `.env`).

### Desktop Client

```bash
pnpm --filter @kizuna/desktop dev
```

Opens the Tauri app with hot-reload for the React frontend. To run just the web frontend without Tauri:

```bash
pnpm --filter @kizuna/desktop vite
```

### Shared Package

The shared package builds automatically as a dependency. To run tests:

```bash
pnpm --filter @kizuna/shared test
```

## Tech Stack

| Component | Technology |
|---|---|
| Server runtime | Node.js 22 |
| HTTP framework | Hono v4 |
| WebSocket | Socket.IO v4 |
| WebRTC SFU | mediasoup v3 |
| Database | SQLite (better-sqlite3) |
| Auth | JWT + bcryptjs |
| Validation | Zod v3 |
| Desktop shell | Tauri v2 (Rust) |
| Frontend | React 18 + Vite 5 |
| State management | Zustand v4 |
| Routing | react-router-dom v6 |
| Monorepo | pnpm workspaces + Turborepo |

## Environment Variables

See `.env.example` in the repository root for a complete reference of all available environment variables.
