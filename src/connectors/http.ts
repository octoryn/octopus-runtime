/**
 * HTTP connector — a real, network-facing connector built on the platform
 * `fetch`. Zero dependencies.
 *
 * It demonstrates the connector contract against an actual side-effecting API:
 *
 * - `render` is pure: it normalizes the request (method, url, headers, body)
 *   and produces a preview. No network. Safe for Shadow and Draft.
 * - `execute` performs the request. For mutating methods it attaches an
 *   `Idempotency-Key` header derived from the runtime's stable idempotency key,
 *   so a retried or redelivered action is safe against idempotent APIs. A
 *   response outside the accepted status set throws, so the runtime records the
 *   action `failed`, fail-closed.
 *
 * ```ts
 * import { createHttpConnector } from "octopus-runtime/connectors/http";
 * const http = createHttpConnector();
 * // action: { connectorId: "http", actionType: "http.request",
 * //           input: { method: "POST", url: "https://api.example.com/things", body: "{...}" } }
 * ```
 *
 * Security: this connector requests whatever URL the workflow plans. If any part
 * of that URL derives from untrusted input, guard it — restrict hosts/schemes in
 * the workflow's planner or with a policy — to avoid SSRF. The runtime governs
 * *whether* the request runs (autonomy/approval); it does not vet the target.
 */

import * as s from "../schema.js";
import { defineAction, defineConnector, type Connector, type ConnectorContext } from "../connector.js";

const httpInput = s.object({
  method: s.enums("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"),
  url: s.string(),
  headers: s.optional(s.record(s.string())),
  /** Raw request body (already serialized, e.g. a JSON string). */
  body: s.optional(s.string()),
  /** Status codes treated as success. Default: any 2xx. */
  okStatuses: s.optional(s.array(s.number()))
});

/** The normalized request produced by `render`. */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  okStatuses?: number[];
}

/** The response recorded by `execute`. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A `fetch`-compatible function, for injection in tests. */
export type FetchLike = typeof fetch;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isOk(status: number, okStatuses: number[] | undefined): boolean {
  return okStatuses ? okStatuses.includes(status) : status >= 200 && status < 300;
}

/**
 * Build an HTTP connector.
 *
 * @param options.fetch      Override the `fetch` implementation (defaults to the
 *                           global `fetch`; injectable for tests).
 * @param options.timeoutMs  Per-request network timeout via `AbortSignal`. This
 *                           is the connector's own timeout; it composes with the
 *                           runtime's governance-level `connectorTimeoutMs`.
 */
export function createHttpConnector(options: { fetch?: FetchLike; timeoutMs?: number } = {}): Connector {
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available; pass options.fetch");
  }

  return defineConnector({
    id: "http",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "http.request",
        input: httpInput,
        // PURE: normalize the request. No network.
        render(input) {
          const request: HttpRequest = {
            method: input.method,
            url: input.url,
            headers: input.headers ?? {}
          };
          if (input.body !== undefined) request.body = input.body;
          if (input.okStatuses !== undefined) request.okStatuses = input.okStatuses;
          return { preview: `${input.method} ${input.url}`, payload: request };
        },
        // SIDE-EFFECTFUL: perform the request. Reached only when the gate permits.
        async execute(rendered, ctx: ConnectorContext) {
          const request = rendered.payload as HttpRequest;
          const headers: Record<string, string> = { ...request.headers };
          // Attach a stable idempotency key on mutating requests, so a retry or
          // redelivery is safe against idempotency-aware APIs.
          if (MUTATING.has(request.method) && headers["Idempotency-Key"] === undefined) {
            headers["Idempotency-Key"] = ctx.idempotencyKey;
          }

          const init: RequestInit = { method: request.method, headers };
          if (request.body !== undefined) init.body = request.body;
          if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
            init.signal = AbortSignal.timeout(options.timeoutMs);
          }

          const res = await fetchImpl(request.url, init);
          const body = await res.text();
          if (!isOk(res.status, request.okStatuses)) {
            throw new Error(`HTTP ${res.status} for ${request.method} ${request.url}`);
          }

          const responseHeaders: Record<string, string> = {};
          res.headers.forEach((value, key) => {
            responseHeaders[key] = value;
          });
          const response: HttpResponse = { status: res.status, headers: responseHeaders, body };
          return {
            output: response,
            effectRefs: [{ kind: "http.response", id: `${request.method} ${request.url}`, url: request.url }]
          };
        }
      })
    ]
  });
}
