# Pingpong API — usage instructions

One endpoint notifies you (Slack and/or email) when a user signs up in any
of your products. Base URL is the production worker URL
(e.g. `https://pingpong.<you>.workers.dev`), or `http://localhost:8787`
during local development.

## Authentication

Every call to `POST /api/ping` must include the shared secret:

```http
Authorization: Bearer <PING_BEARER_TOKEN>
```

- Missing or wrong credentials → `401 {"ok":false,"error":"unauthorized"}`.
- Never log or expose this credential. It is one shared secret for all
  your products.

## `POST /api/ping`

Body is JSON (`Content-Type: application/json`). Only `POST` is accepted.

| Field      | Type                       | Required | Rules / defaults                                   |
| ---------- | -------------------------- | -------- | -------------------------------------------------- |
| `product`  | string                     | yes      | Non-empty. Shown in every notification.            |
| `event`    | string                     | no       | Defaults to `"signup"`. e.g. `"trial_started"`.    |
| `channels` | string or array of strings | no       | `"slack"`, `"email"`, `"all"` (default), or a list like `["email"]`. `"all"` expands to every known outlet. Unknown values → `400`. |
| `message`  | string                     | no       | Free-form note, included in the notification.      |
| `user`     | object                     | no       | Optional `name` / `email` / `id` plus any extra fields, carried through into the notification verbatim. Must be an object. |

Minimal body: `{"product":"my-app"}`.

curl:

```bash
curl -X POST https://pingpong.<you>.workers.dev/api/ping \
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

## Responses

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
| `skipped`   | Outlet not configured server-side (with `detail` reason). Not a failure — no need to retry; tell the operator to configure it. |
| `failed`    | Configured outlet errored (with `detail`). Response is `502` with `"ok": false`; retrying is reasonable. |

Error responses are always `{"ok":false,"error":"<reason>"}`:

| HTTP | When                                              |
| ---- | ------------------------------------------------- |
| 400  | Body is not JSON, or validation failed (the `error` string names the field). |
| 401  | Missing/wrong bearer credential.                  |
| 404  | Unknown path, or wrong method on a known path.    |
| 500  | Server credential not configured (operator issue). |
| 502  | A requested, configured channel failed — see `outcomes[].detail`. |

## Integration guidance

- Call it **fire-and-forget** from the signup flow: short timeout
  (~5–10 s). Never let a ping failure fail the signup itself.
- `ok: true` with `skipped` outcomes: your call was fine, an outlet
  needs operator setup — don't retry.
- `502` / `ok: false`: temporary delivery failure — retry with backoff,
  then surface.
- `GET /api/health` (no auth) returns
  `{"ok":true,"channels":{"slack":true,"email":false}}` — check it before
  debugging a missing notification.
