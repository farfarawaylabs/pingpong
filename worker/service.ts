// Business-logic tier: validates + executes pings.
// Knows nothing about HTTP (no Request/Response); the thin API tier in
// index.ts handles auth, parsing bodies, and mapping results to responses.

import type {
  ChannelName,
  ChannelSelector,
  PingRequest,
  PingResult,
  PingUser,
} from "./types.js";
import {
  buildNotifiers,
  toPingEvent,
  type ChannelConfig,
} from "./channels.js";

export class ValidationError extends Error {}

const KNOWN_CHANNELS: ChannelName[] = ["slack", "email"];

function normalizeChannels(
  raw: ChannelSelector | ChannelSelector[] | undefined,
): ChannelName[] {
  if (raw === undefined) return [...KNOWN_CHANNELS]; // default: all
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new ValidationError(`"channels" must not be empty`);
  const out: ChannelName[] = [];
  for (const item of list) {
    if (item === "all") {
      return [...KNOWN_CHANNELS];
    }
    if (typeof item !== "string" || !KNOWN_CHANNELS.includes(item as ChannelName)) {
      throw new ValidationError(
        `"channels" must contain only ${KNOWN_CHANNELS.map((c) => `"${c}"`).join(", ")} or "all"`,
      );
    }
    if (!out.includes(item as ChannelName)) out.push(item as ChannelName);
  }
  return out;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ValidationError(`"${field}" must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function asOptionalUser(value: unknown): PingUser | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`"user" must be an object when provided`);
  }
  return value as PingUser;
}

/** Validate a raw parsed-JSON body into a PingRequest. Throws ValidationError. */
export function parsePingRequest(body: unknown): PingRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  return {
    product: asNonEmptyString(b.product, "product"),
    event: asOptionalString(b.event, "event") ?? "signup",
    channels: normalizeChannels(
      b.channels as ChannelSelector | ChannelSelector[] | undefined,
    ),
    message: asOptionalString(b.message, "message"),
    user: asOptionalUser(b.user),
  };
}

export class PingService {
  private config: ChannelConfig;

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  async ping(req: PingRequest): Promise<PingResult> {
    const event = toPingEvent(req);
    const notifiers = buildNotifiers(this.config).filter((n) =>
      req.channels.includes(n.name),
    );
    const outcomes = await Promise.all(
      notifiers.map(async (n) => {
        if (!n.isConfigured()) {
          return {
            channel: n.name,
            status: "skipped" as const,
            detail: "channel not configured",
          };
        }
        try {
          await n.send(event);
          return { channel: n.name, status: "delivered" as const };
        } catch (e) {
          return {
            channel: n.name,
            status: "failed" as const,
            detail: e instanceof Error ? e.message : String(e),
          };
        }
      }),
    );
    return {
      ok: outcomes.every((o) => o.status !== "failed"),
      product: req.product,
      event: req.event,
      outcomes,
    };
  }
}
