// ALL outbound channel code lives in this file.
// Slack, email, and any future outlet (SMS, Discord, ...) go here so there
// is exactly one place to find and change channel-related code.
// The business-logic tier (service.ts) only talks to the `Notifier`
// interface below and never touches channel APIs directly.

import type { ChannelName, PingUser } from "./types.js";

/** Normalized event handed to every notifier. */
export interface PingEvent {
  product: string;
  event: string;
  message?: string;
  user?: PingUser;
  /** ISO timestamp of when the worker received the ping. */
  receivedAt: string;
}

/**
 * Minimal structural type for the Cloudflare Email Service binding.
 * (See https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 * — the recommended `send()` method with the structured builder.)
 * Declared structurally so the business tier stays decoupled from the
 * generated Env type and stays easy to unit-test with a fake.
 */
export interface EmailSender {
  send(message: {
    to: string;
    from: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

/** Everything a notifier needs, assembled by the thin API tier from Env. */
export interface ChannelConfig {
  slackWebhookUrl?: string;
  emailBinding?: EmailSender;
  emailTo?: string;
  emailFrom: string;
}

export interface Notifier {
  readonly name: ChannelName;
  /** False when the channel is not configured (webhook/binding missing). */
  isConfigured(): boolean;
  /** Resolves on success, throws with a short reason on failure. */
  send(event: PingEvent): Promise<void>;
}

// ---------------------------------------------------------------------------
// Message formatting (shared by all channels)
// ---------------------------------------------------------------------------

function userLabel(user?: PingUser): string {
  if (!user) return "n/a";
  return user.name ?? user.email ?? user.id ?? "n/a";
}

function extraUserFields(user?: PingUser): string {
  if (!user) return "";
  const known = new Set(["email", "name", "id"]);
  return Object.entries(user)
    .filter(([k, v]) => !known.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// Slack — Incoming Webhook
// (https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)
// Plain POST of { text, blocks } to the webhook URL. No library needed.
// Connect a channel: Slack app -> Incoming Webhooks ON -> "Add New Webhook
// to Workspace" -> copy URL -> `wrangler secret put SLACK_WEBHOOK_URL`.
// ---------------------------------------------------------------------------

export function formatSlackText(event: PingEvent): string {
  const who = userLabel(event.user);
  const email =
    event.user?.email && event.user.email !== who
      ? ` (${event.user.email})`
      : "";
  const note = event.message ? `\n>${event.message}` : "";
  return `:tada: New *${event.event}* on *${event.product}* — ${who}${email}${note}`;
}

export class SlackNotifier implements Notifier {
  readonly name: ChannelName = "slack";
  private webhookUrl?: string;

  constructor(webhookUrl?: string) {
    this.webhookUrl = webhookUrl;
  }

  isConfigured(): boolean {
    return !!this.webhookUrl;
  }

  async send(event: PingEvent): Promise<void> {
    if (!this.webhookUrl) throw new Error("SLACK_WEBHOOK_URL is not set");
    const text = formatSlackText(event);
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      }),
    });
    if (!res.ok) {
      const hint = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Slack webhook HTTP ${res.status}${hint ? `: ${hint}` : ""}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Email — Cloudflare Email Service `send_email` binding
// (https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
// Wrangler: `"send_email": [{ "name": "EMAIL" }]`. Locally the send is
// simulated (logged to console) unless the binding uses `"remote": true.
// ---------------------------------------------------------------------------

export function formatEmailSubject(event: PingEvent): string {
  return `[ping] New ${event.event} on ${event.product}`;
}

export function formatEmailText(event: PingEvent): string {
  const lines = [
    `New ${event.event} on ${event.product}`,
    `Received: ${event.receivedAt}`,
    `User: ${userLabel(event.user)}`,
  ];
  if (event.user?.email) lines.push(`Email: ${event.user.email}`);
  if (event.user?.id) lines.push(`User ID: ${event.user.id}`);
  const extra = extraUserFields(event.user);
  if (extra) lines.push(extra);
  if (event.message) lines.push(`Note: ${event.message}`);
  return lines.join("\n");
}

export class EmailNotifier implements Notifier {
  readonly name: ChannelName = "email";
  private binding?: EmailSender;
  private to?: string;
  private from?: string;

  constructor(binding?: EmailSender, to?: string, from?: string) {
    this.binding = binding;
    this.to = to;
    this.from = from;
  }

  isConfigured(): boolean {
    return !!this.binding && !!this.to && !!this.from;
  }

  async send(event: PingEvent): Promise<void> {
    if (!this.binding) throw new Error("EMAIL send_email binding is missing");
    if (!this.to) throw new Error("NOTIFY_EMAIL_TO is not set");
    if (!this.from) throw new Error("NOTIFY_EMAIL_FROM is not set");
    const text = formatEmailText(event);
    await this.binding.send({
      to: this.to,
      from: this.from,
      subject: formatEmailSubject(event),
      text,
      html: `<pre>${escapeHtml(text)}</pre>`,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory — one list of every outlet, configured or not. Unconfigured ones
// report "skipped" instead of failing, so partial setups keep working.
// ---------------------------------------------------------------------------

export function buildNotifiers(config: ChannelConfig): Notifier[] {
  return [
    new SlackNotifier(config.slackWebhookUrl),
    new EmailNotifier(config.emailBinding, config.emailTo, config.emailFrom),
  ];
}

export function toPingEvent(
  input: { product: string; event: string; message?: string; user?: PingUser },
  receivedAt: Date = new Date(),
): PingEvent {
  return {
    product: input.product,
    event: input.event,
    message: input.message,
    user: input.user,
    receivedAt: receivedAt.toISOString(),
  };
}
