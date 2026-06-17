# Contributing to Kizuna

## Prerequisites

- **Node.js** >= 22.0.0
- **pnpm** >= 9.0.0
- **Rust** (for Tauri desktop builds)
- **Docker** (for containerized deployment)

## Development Setup

```bash
# Clone the repository
git clone https://github.com/your-org/kizuna.git
cd kizuna

# Install dependencies
pnpm install

# Start the server in development mode
pnpm dev

# Start the desktop app in development mode
pnpm dev:desktop
```

## Project Structure

```
kizuna/
├── apps/
│   ├── server/        # Hono HTTP/WebSocket server (TypeScript)
│   └── desktop/       # Tauri v2 desktop client (React + Rust)
├── packages/
│   └── shared/        # Shared TypeScript library (types, API client, crypto)
└── scripts/           # Setup and build scripts
```

## Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start server in dev mode |
| `pnpm typecheck` | Run TypeScript type checking on all packages |
| `pnpm lint` | Run ESLint on all packages |
| `pnpm format` | Format code with Prettier |
| `pnpm format:check` | Check code formatting |
| `pnpm build` | Build server and desktop |

## Code Conventions

- Use TypeScript strict mode
- Use Prettier for code formatting (`pnpm format`)
- Use ESLint for linting (`pnpm lint`)
- Follow existing patterns in the codebase
- Write meaningful commit messages
- Keep components small and focused

## Pull Request Process

1. Fork the repository and create a feature branch
2. Ensure `pnpm typecheck` and `pnpm lint` pass
3. Update documentation if needed
4. Submit a PR to the `master` branch
