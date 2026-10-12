# Pingpong — centralized signup ping service

One Cloudflare Worker that your products call whenever a new user signs up.
It fans the event out to Slack and/or email so you never re-implement
notifications per app.

Code layout (two tiers):

- **Thin API tier** — [worker/index.ts](worker/index.ts): routing, bearer
  auth, JSON parsing, response mapping. No notification logic.
- **Business-logic tier** — [worker/service.ts](worker/service.ts)
  (`PingService`) plus [worker/channels.ts](worker/channels.ts), where **all**
  Slack/email code lives in one place (`SlackNotifier`, `EmailNotifier`,
  message templates, `buildNotifiers`). Add future outlets there.
- Shared shapes — [worker/types.ts](worker/types.ts).

## API reference (for coders and AI agents)

> Standalone consumer doc: [docs/instructions.md](docs/instructions.md) —
> hand it to anyone (or any agent) integrating a product.

Base URL: production worker URL (e.g. `https://pingpong.<you>.workers.dev`),
or `http://localhost:8787` under `npx wrangler dev`.

### Authentication

Every call to `POST /api/ping` must carry the shared secret:

```http
Authorization: Bearer <PING_BEARER_TOKEN>
```

- Missing or wrong credentials → `401 {"ok":false,"error":"unauthorized"}`.
- If the server itself has no secret configured → `500` (operator error,
  fix with `wrangler secret put PING_BEARER_TOKEN`).
- Never log or expose this credential. It is one shared secret for all
  your products (this is an internal service, not per-product keys).

### `POST /api/ping`

Request body is JSON (`Content-Type: application/json`).

| Field      | Type                             | Required | Rules / defaults                                   |
| ---------- | -------------------------------- | -------- | -------------------------------------------------- |
| `product`  | string                           | yes      | Non-empty. Shown in every notification.            |
| `event`    | string                           | no       | Defaults to `"signup"`. e.g. `"trial_started"`.    |
| `channels` | string or array of strings       | no       | `"slack"`, `"email"`, `"all"` (default), or a list like `["email"]`. `"all"` expands to every known outlet. Unknown values → `400`. |
| `message`  | string                           | no       | Free-form note, included in the notification.      |
| `user`     | object                           | no       | Optional `name` / `email` / `id` plus any extra fields, which are carried through into the notification verbatim. Must be an object, not a string. |

Minimal body: `{"product":"my-app"}`. Only `POST` is accepted.

curl:

```bash
curl -X POST http://localhost:8787/api/ping \
  -H "Authorization: Bearer $PING_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "demo-store",
    "event": "signup",
    "channels": "all",
    "message": "came from landing page",
    "user": { "name": "Ada", "email": "ada@example.com", "plan": "pro" }
  }'
```

JavaScript / TypeScript:

```ts
async function pingSignup(input: {
  product: string;
  user?: Record<string, unknown>;
  channels?: "slack" | "email" | "all" | ("slack" | "email")[];
}) {
  const res = await fetch("https://pingpong.<you>.workers.dev/api/ping", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.PING_BEARER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event: "signup", channels: "all", ...input }),
  });
  const data = await res.json();
  if (!data.ok) console.error("ping failed:", res.status, data);
  return data;
}
```

Python (stdlib only):

```python
import json, os, urllib.request

def ping_signup(product, user=None, channels="all", event="signup"):
    req = urllib.request.Request(
        "https://pingpong.<you>.workers.dev/api/ping",
        data=json.dumps({
            "product": product, "event": event,
            "channels": channels, "user": user,
        }).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['PING_BEARER_TOKEN']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)
```

### Responses

Success — `200` (nothing failed):

```json
{
  "ok": true,
  "product": "demo-store",
  "event": "signup",
  "outcomes": [
    { "channel": "slack", "status": "delivered" },
    { "channel": "email", "status": "delivered" }
  ]
}
```

Per-channel `status` values:

| Status      | Meaning                                                        |
| ----------- | -------------------------------------------------------------- |
| `delivered` | Outlet accepted the notification.                              |
| `skipped`   | Outlet not configured server-side (with `detail` reason). Not a failure — fix config, no need to retry the ping. |
| `failed`    | Configured outlet errored (with `detail`). Response is `502` with `"ok": false`; retrying the ping is reasonable. |

Error responses are always `{"ok":false,"error":"<reason>"}`:

| HTTP | When                                              |
| ---- | ------------------------------------------------- |
| 400  | Body is not JSON, or validation failed (the `error` string names the field). |
| 401  | Missing/wrong bearer credential.                  |
| 404  | Unknown path, or wrong method on a known path.    |
| 500  | `PING_BEARER_TOKEN` not configured on the server. |
| 502  | A requested, configured channel failed — see `outcomes[].detail`. |

### Integration guidance for agents

- Call it **fire-and-forget** from the signup flow: short timeout
  (~5–10 s), never let a ping failure fail the signup itself.
- `ok: true` with `skipped` outcomes means your call was fine but an
  outlet needs operator setup — surface that to the human, don't retry.
- `502` / `ok: false` means temporary delivery failure — retry with
  backoff, then surface.
- `GET /api/health` (no auth) returns
  `{"ok":true,"channels":{"slack":true,"email":false}}` — use it to check
  wiring before debugging a missing notification.

### Connecting a Slack channel

1. Create a Slack app at `api.slack.com/apps`, enable **Incoming Webhooks**,
   click **Add New Webhook to Workspace**, pick the channel.
2. Store the webhook URL as a secret (local and production):
   `wrangler secret put SLACK_WEBHOOK_URL` (locally: `.dev.vars`).

### Email

Sending uses the Cloudflare Email Service `send_email` binding
(`EMAIL` in [wrangler.jsonc](wrangler.jsonc)). Before production:

1. Onboard a sending domain: Cloudflare dashboard → Compute → Email
   Service → Email Sending (Cloudflare DNS required).
2. Set `NOTIFY_EMAIL_FROM` to an address on that domain and
   `NOTIFY_EMAIL_TO` to your inbox (`wrangler secret put NOTIFY_EMAIL_TO`).

Locally, email is simulated: wrangler logs From/To/Subject and saves the
bodies under `.wrangler/tmp/email/` instead of sending.

## Local development & testing

```bash
cp .dev.vars.example .dev.vars   # then fill in real values
npx wrangler dev --port 8787     # API at http://localhost:8787
npm run dev                      # or: frontend + worker via Vite plugin
```

Business-tier tests (validation, delivery, channel selection, skip/fail
paths) live outside the repo and run against the bundled worker sources:

```bash
./node_modules/.bin/esbuild worker/service.ts --bundle --platform=node \
  --format=esm --outfile=/tmp/ping-bundle.mjs
node /tmp/ping-test.mjs
```
