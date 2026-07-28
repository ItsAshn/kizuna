---
title: Webhooks
description: Kizuna webhooks — incoming webhooks let external services post into a channel, outgoing webhooks push server events to an external URL with HMAC-signed payloads, retries, and Discord/Slack-compatible formats.
---

# Webhooks

Kizuna supports webhooks in both directions:

| | Direction | Use it for |
|---|---|---|
| **Incoming** | External service → Kizuna | CI results, GitHub activity, alerts posted into a channel |
| **Outgoing** | Kizuna → external service | Bridging a channel to Discord/Slack, logging, automation |

Both are managed in **Server Settings → Webhooks**, or per channel in **Channel Settings → Integrations**.

## Permissions

Managing webhooks in either direction requires the **`manage_webhooks`** permission, granted per
role in **Server Settings → Roles**. Admins always have it.

::: warning Upgrading from an earlier version
Webhook management previously used `manage_channels`. On upgrade, every role holding
`manage_channels` is automatically granted `manage_webhooks`, so no one loses access. If you want
to separate the two, remove `manage_webhooks` from those roles afterwards.
:::

Treat the permission as sensitive: an outgoing webhook can forward channel messages to any external
server.

## Incoming webhooks

Creating one gives you a URL:

```
https://your-server.example.com/api/webhooks/incoming/<token>
```

Anyone holding that URL can post to the channel, so treat it like a password. If it leaks, use
**regenerate url** to rotate the token without losing the webhook's identity or history.

### Posting a message

```bash
curl -X POST 'https://your-server.example.com/api/webhooks/incoming/<token>' \
  -H 'Content-Type: application/json' \
  -d '{"content":"Deploy finished ✅"}'
```

Supported payload shapes, tried in order:

1. **Plain text** — `content`, `text`, or `message`
2. **GitHub** — send the `X-GitHub-Event` header and Kizuna formats it. Handles `push`, `release`,
   `issues`, `issue_comment`, `pull_request`, `star`, `fork`, and `workflow_run`. Set GitHub's
   content type to `application/json`. The `ping` event returns `202` without posting, which is
   what turns the hook green in GitHub's UI.
3. **Discord-style** — an `embeds` array (title, description, fields, footer)
4. **Slack-style** — an `attachments` array (`text`, `pretext`, `fallback`)

Per-message `username` and `avatar_url` override the webhook's defaults, as in Discord.

Rate limit: **30 messages per minute per webhook**. Over that returns `429` with `Retry-After: 60`.

## Outgoing webhooks

An outgoing webhook POSTs to a URL you choose whenever a subscribed event happens.

### Events

| Event | Fires when | Channel-scoped |
|---|---|---|
| `message.created` | A message is posted | yes |
| `message.updated` | A message is edited | yes |
| `message.deleted` | A message is deleted | yes |
| `channel.created` | A channel is created | no |
| `channel.updated` | A channel is renamed or reconfigured | yes |
| `channel.deleted` | A channel is deleted | yes |
| `member.joined` | Someone joins the server | no |
| `member.left` | Someone deletes their own account | no |
| `member.removed` | Someone is kicked or banned | no |

A webhook scoped to a single channel only receives that channel's events, and only the
channel-scoped ones. Choose **all channels** for server-wide events like `member.joined`.

### Payload formats

**`kizuna`** (default) — structured JSON, signed:

```json
{
  "event": "message.created",
  "delivery_id": "9c0f1298-df36-4c90-9a95-bda508cba772",
  "timestamp": 1785231133,
  "server": { "name": "My Server", "url": "https://your-server.example.com" },
  "data": {
    "channel": { "id": "general", "name": "general" },
    "user": { "id": "…", "username": "alice" },
    "message": { "id": "…", "content": "hello" }
  }
}
```

**`discord`** — `{ "content": "...", "username": "..." }`. Point the URL straight at a Discord
channel webhook to bridge a Kizuna channel into Discord with no glue code.

**`slack`** — `{ "text": "..." }`.

### Verifying signatures

Every delivery carries these headers:

| Header | Meaning |
|---|---|
| `X-Kizuna-Event` | Event name (or `ping` for a manual test) |
| `X-Kizuna-Delivery` | Unique id for this delivery, stable across retries |
| `X-Kizuna-Timestamp` | Epoch seconds, included in the signed material |
| `X-Kizuna-Signature` | `sha256=<hex HMAC-SHA256>` |

The signature is computed over `` `${timestamp}.${rawBody}` `` using the webhook's signing secret.
Verify against the **raw** request body, before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, headers, secret) {
  const timestamp = headers['x-kizuna-timestamp']
  const signature = headers['x-kizuna-signature']
  if (!timestamp || !signature) return false

  // Reject replays of old deliveries.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false

  const expected = 'sha256=' + createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
```

Rotating the secret (**rotate secret**) invalidates signatures for anything still using the old one.

### Delivery, retries, and auto-disable

- Up to **4 attempts** at 0s, 5s, 30s, and 120s.
- Retried on network errors, timeouts, `408`, `429`, and `5xx`. Other `4xx` responses are treated as
  permanent misconfiguration and are **not** retried.
- 10s timeout per request.
- **60 events per minute per webhook**; excess is dropped rather than queued.
- After **20 consecutive failures** the webhook is automatically disabled and shows the reason in
  the UI. Fix the endpoint and toggle it back on.

Use **send test** to fire a synthetic `ping` and see the real status code and latency. The last 20
delivery attempts are listed under each webhook.

### Avoiding loops

Two guards prevent a webhook from feeding itself:

- A URL pointing at any `/api/webhooks/incoming/` endpoint is rejected outright.
- **skip bridged messages** makes a webhook ignore messages that arrived via an incoming webhook.
  Turn it on when two servers bridge to each other, or they will echo forever.

### Private network targets

By default, outgoing webhooks cannot target `localhost`, private ranges (`10/8`, `172.16/12`,
`192.168/16`), link-local addresses (`169.254/16`, which includes cloud metadata endpoints), or
`.local`/`.internal` hostnames. This keeps a webhook from being pointed at services on the host
network.

If you are legitimately bridging to something on your LAN — Home Assistant, an internal automation
runner — set:

```bash
ALLOW_PRIVATE_WEBHOOK_TARGETS=true
```

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OUTGOING_WEBHOOK_TIMEOUT_MS` | `10000` | Per-request timeout |
| `OUTGOING_WEBHOOK_MAX_ATTEMPTS` | `4` | Attempts before an event is dropped |
| `OUTGOING_WEBHOOK_CONCURRENCY` | `4` | Deliveries in flight at once |
| `OUTGOING_WEBHOOK_RATE_PER_MIN` | `60` | Events queued per webhook per minute |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | `false` | Allow private/loopback targets |
