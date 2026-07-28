# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Kizuna, please report it privately by emailing the maintainers. Do not create a public issue.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

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

### Dependency Auditing

CI runs `pnpm audit --prod --audit-level high` on every pull request. The scope
is deliberate: `--prod` excludes build and test tooling that never reaches a
user, and `high` is the bar worth blocking a merge for. An unscoped audit failed
on every PR, which trained everyone to ignore the check.

A small set of advisories is accepted in `pnpm.auditConfig.ignoreGhsas` because
no fix is reachable from this repository. Each should be revisited whenever the
owning dependency is upgraded:

| Advisory                                                                                                                                 | Package      | Path                                                                       | Why it is accepted                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GHSA-2p57-rm9w-gvfp`                                                                                                                    | `ip`         | `nat-upnp` → `ip`                                                          | No patched version exists; `ip` is unmaintained. Only reachable during UPnP port mapping against the local gateway. Fix requires replacing `nat-upnp`.                               |
| `GHSA-xq3m-2v4x-88gg`, `GHSA-66ff-xgx4-vchm`, `GHSA-75px-5xx7-5xc7`, `GHSA-jvwf-75h9-cwgg`, `GHSA-685m-2w69-288q`, `GHSA-wcpc-wj8m-hjx6` | `protobufjs` | `@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs@6` | Patched only in `protobufjs` 7.x, but `onnx-proto@4` pins `^6` and its generated code targets the 6.x API. Parses only model files shipped with the tag generator, never user input. |
| `GHSA-f88m-g3jw-g9cj`                                                                                                                    | `sharp`      | `@xenova/transformers` → `sharp@0.32.6`                                    | `@xenova/transformers@2.17.2` pins `sharp@^0.32`. The server's own direct `sharp` dependency is 0.35.x and unaffected; this copy is used only by the tag generator.                  |

Two related fixes are applied rather than ignored: `form-data` is forced to
`>=2.5.6` through `pnpm.overrides` (the vulnerable copy arrives via the
deprecated `request`, pulled in by `nat-upnp`), and `adm-zip` is held at `>=0.6.0`
because it parses user-uploaded GIF and sticker packs, which makes the crafted
ZIP memory-exhaustion advisory directly reachable.

### Best Practices for Self-Hosters

- Always set a strong `JWT_SECRET` in your `.env` file
- Keep your server and dependencies updated (`pnpm audit`)
- Use a firewall to restrict access to the mediasoup port range
- Back up your `data/` and `uploads/` directories regularly
- Run the server behind a reverse proxy (Caddy is pre-configured)
