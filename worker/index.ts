// Thin API tier: HTTP only — routing, bearer auth, JSON parsing, and
// mapping business-tier results to responses. All notification logic lives
// in service.ts + channels.ts; nothing here decides how a ping is delivered.

import { PingService, ValidationError, parsePingRequest } from "./service.js";
import { buildNotifiers, type ChannelConfig } from "./channels.js";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

const unauthorized = () =>
  json({ ok: false, error: "unauthorized" }, 401);

/**
 * A required secret that is missing locally (wrangler dev warns) arrives as
 * undefined — treat empty/missing as "channel not configured" so partial
 * setups keep working and /api/health reports the truth.
 */
function optSecret(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function channelConfigFromEnv(env: Env): ChannelConfig {
  return {
    slackWebhookUrl: optSecret(env.SLACK_WEBHOOK_URL),
    emailBinding: env.EMAIL,
    emailTo: optSecret(env.NOTIFY_EMAIL_TO),
    emailFrom: env.NOTIFY_EMAIL_FROM || "ping@example.com",
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Public liveness + channel wiring status (booleans only, no secrets).
    if (url.pathname === "/api/health" && request.method === "GET") {
      const notifiers = buildNotifiers(channelConfigFromEnv(env));
      return json({
        ok: true,
        channels: Object.fromEntries(
          notifiers.map((n) => [n.name, n.isConfigured()]),
        ),
      });
    }

    if (url.pathname === "/api/ping" && request.method === "POST") {
      if (!env.PING_BEARER_TOKEN) {
        return json(
          { ok: false, error: "server misconfigured: PING_BEARER_TOKEN not set" },
          500,
        );
      }
      const auth = request.headers.get("Authorization") ?? "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token !== env.PING_BEARER_TOKEN) return unauthorized();

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "body must be valid JSON" }, 400);
      }

      try {
        const req = parsePingRequest(body);
        const result = await new PingService(
          channelConfigFromEnv(env),
        ).ping(req);
        // 200 when nothing failed; 502 when a requested, configured
        // channel failed to deliver. "skipped" (unconfigured) is not a
        // failure — see per-channel outcomes for details.
        return json(result, result.ok ? 200 : 502);
      } catch (e) {
        if (e instanceof ValidationError) {
          return json({ ok: false, error: e.message }, 400);
        }
        throw e;
      }
    }

    if (url.pathname === "/api/" && request.method === "GET") {
      return Response.json({ name: "Cloudflare" });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
