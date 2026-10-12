// Shared contract types for the ping service.
//
// These are plain data shapes used by both tiers:
//   - worker/index.ts (thin API tier) parses HTTP into a PingRequest
//   - worker/service.ts (business-logic tier) executes it
// They deliberately know nothing about Request/Response or the Worker Env.

/** Notification outlet. Add new channels here as the service grows. */
export type ChannelName = "slack" | "email";

/** What the caller may pass as `channels`: one outlet, "all", or a list. */
export type ChannelSelector = ChannelName | "all";

/** Optional free-form details about the user who signed up. */
export interface PingUser {
  email?: string;
  name?: string;
  id?: string;
  /** Any extra product-specific fields are carried through to the message. */
  [key: string]: unknown;
}

/** Validated body of POST /api/ping. */
export interface PingRequest {
  /** Name of the product reporting the signup (required). */
  product: string;
  /** Event name, e.g. "signup". Defaults to "signup". */
  event: string;
  /** Which outlets to notify. Defaults to all. */
  channels: ChannelName[];
  /** Optional human note included in the notification. */
  message?: string;
  /** Optional user details included in the notification. */
  user?: PingUser;
}

export type ChannelStatus = "delivered" | "skipped" | "failed";

export interface ChannelOutcome {
  channel: ChannelName;
  status: ChannelStatus;
  /** Human-readable reason for "skipped" / "failed". Absent when delivered. */
  detail?: string;
}

export interface PingResult {
  ok: boolean;
  product: string;
  event: string;
  outcomes: ChannelOutcome[];
}
