---
title: Security
description: Security overview for Kizuna — JWT authentication, end-to-end encryption with NaCl, password hashing, Proof-of-Work registration protection, and vulnerability reporting.
---

# Security

## Reporting a Vulnerability

If you discover a security vulnerability in Kizuna, please report it privately by emailing the maintainers. Do not create a public issue.

## Supported Versions

| Version | Supported |
|---|---|
| 0.1.x | :white_check_mark: |

## Security Model

### Authentication

- JWT-based authentication with short-lived access tokens and refresh tokens
- Token IDs enable server-side revocation
- Proof-of-Work required for registration to prevent abuse
- `bcryptjs` used for password hashing (12 rounds)

### Encryption

- End-to-end encryption for direct messages using NaCl (tweetnacl)
- Public key exchange via the server (server never sees private keys)
- Encrypted DM payloads are base64-encoded in transit

### Transport Security

- Caddy provides automatic HTTPS via Let's Encrypt in Docker deployments
- WebSocket connections use the same TLS-secured connection
- CORS is configured to allow only trusted origins

### Server-Side

- SQLite database with parameterized queries to prevent SQL injection
- All user input validated with Zod schemas
- File uploads validated and processed with sharp
- Rate limiting on authentication endpoints
- Password hashing with bcryptjs (12 salt rounds)
