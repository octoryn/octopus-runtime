/**
 * Example connector: email.
 *
 * Demonstrates the whole connector contract in one file — a typed input schema,
 * a pure `render`, and a side-effectful `execute` — while staying stateless.
 * All state (the outbox, dedup set) lives in an injected transport, never in
 * module scope, so the connector itself holds nothing.
 *
 * The default {@link inMemoryTransport} "sends" into an inspectable array, so
 * the connector is runnable and testable with no network or credentials. A real
 * deployment injects an SMTP/API transport and reads credentials from the
 * runtime's SecretProvider inside that transport.
 */

import * as s from "../schema.js";
import { defineAction, defineConnector, type Connector, type ConnectorContext } from "../connector.js";

const emailInput = s.object({
  to: s.array(s.string()),
  subject: s.string(),
  body: s.string(),
  cc: s.optional(s.array(s.string())),
});

/** The concrete message a transport delivers. */
export interface EmailMessage {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
}

/** Options passed to a transport alongside the message. */
export interface DeliverOptions {
  /** Stable key for deduping repeated deliveries across retries. */
  idempotencyKey: string;
}

/** How an email connector actually delivers a message. Injected, stateless-friendly. */
export interface EmailTransport {
  deliver(message: EmailMessage, options: DeliverOptions): Promise<{ messageId: string }>;
}

/** A message recorded by {@link inMemoryTransport}. */
export interface SentEmail extends EmailMessage {
  messageId: string;
  idempotencyKey: string;
}

/**
 * A transport that "sends" into an inspectable outbox and dedupes by
 * idempotency key. Returns both the transport and the outbox array so callers
 * (examples, tests) can assert on what was sent.
 */
export function inMemoryTransport(): { transport: EmailTransport; outbox: SentEmail[] } {
  const outbox: SentEmail[] = [];
  const seen = new Map<string, string>(); // idempotencyKey -> messageId
  let counter = 0;

  const transport: EmailTransport = {
    async deliver(message, options) {
      const existing = seen.get(options.idempotencyKey);
      if (existing !== undefined) return { messageId: existing };

      const messageId = `msg_${++counter}`;
      seen.set(options.idempotencyKey, messageId);
      outbox.push({ ...message, messageId, idempotencyKey: options.idempotencyKey });
      return { messageId };
    },
  };

  return { transport, outbox };
}

/** Build an email connector backed by the given transport. */
export function createEmailConnector(transport: EmailTransport): Connector {
  return defineConnector({
    id: "email",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "email.send",
        input: emailInput,
        // PURE: build the message; no delivery. Safe for Shadow and Draft.
        render(input) {
          const recipients = [...input.to, ...(input.cc ?? [])].join(", ");
          const message: EmailMessage = {
            to: input.to,
            subject: input.subject,
            body: input.body,
          };
          if (input.cc !== undefined) message.cc = input.cc;
          return {
            preview: `Email to ${recipients} — "${input.subject}"`,
            payload: message,
          };
        },
        // SIDE-EFFECTFUL: deliver. Called only on the Autonomous path or after approval.
        async execute(rendered, ctx: ConnectorContext) {
          const message = rendered.payload as EmailMessage;
          const { messageId } = await transport.deliver(message, {
            idempotencyKey: ctx.idempotencyKey,
          });
          return {
            output: { messageId },
            effectRefs: [{ kind: "email.message", id: messageId }],
          };
        },
      }),
    ],
  });
}
