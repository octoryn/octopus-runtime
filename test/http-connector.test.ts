import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  idempotencyKey,
  type TriggerEvent,
} from "../src/index.js";
import { createHttpConnector, type HttpResponse } from "../src/connectors/http.js";

interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const received: Received[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/fail") {
        res.writeHead(500);
        res.end("boom");
      } else if (req.url === "/missing") {
        res.writeHead(404);
        res.end("not found");
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ok:${req.method}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

interface CallPayload {
  method: string;
  url: string;
  body?: string;
  okStatuses?: number[];
}

function httpRuntime(autonomy: AutonomyLevel) {
  return createRuntime({
    connectors: [createHttpConnector()],
    clock: new ManualClock(),
    workflows: [
      defineWorkflow<CallPayload>({
        id: "call",
        match: matchSource("call"),
        plan: ({ event }) => [
          {
            ref: "r",
            connectorId: "http",
            actionType: "http.request",
            requestedAutonomy: autonomy,
            input: event.payload,
          },
        ],
      }),
    ],
  });
}

function callEvent(id: string, payload: CallPayload): TriggerEvent<CallPayload> {
  return { id, source: "call", occurredAt: "2020-01-01T00:00:00.000Z", payload };
}

test("GET executes against a real server and records the response", async () => {
  const runtime = httpRuntime(AutonomyLevel.Autonomous);
  const run = await runtime.run("call", callEvent("get-1", { method: "GET", url: `${base}/echo` }));
  const result = run.results[0];

  assert.equal(result?.outcome, "executed");
  const output = result?.output as HttpResponse;
  assert.equal(output.status, 200);
  assert.equal(output.body, "ok:GET");
  assert.equal(result?.effectRefs?.[0]?.kind, "http.response");
});

test("POST attaches the runtime's idempotency key as an Idempotency-Key header", async () => {
  const runtime = httpRuntime(AutonomyLevel.Autonomous);
  const event = callEvent("post-1", { method: "POST", url: `${base}/things`, body: '{"a":1}' });
  await runtime.run("call", event);

  const last = received.at(-1);
  assert.equal(last?.method, "POST");
  assert.equal(last?.body, '{"a":1}');
  assert.equal(last?.headers["idempotency-key"], idempotencyKey("call", "post-1", "r"));
});

test("a non-2xx response fails closed", async () => {
  const runtime = httpRuntime(AutonomyLevel.Autonomous);
  const run = await runtime.run("call", callEvent("fail-1", { method: "GET", url: `${base}/fail` }));
  const result = run.results[0];

  assert.equal(result?.outcome, "failed");
  assert.equal(result?.reason, "execute_failed");
  assert.match(result?.error?.message ?? "", /HTTP 500/);
});

test("okStatuses lets a caller accept a non-2xx status", async () => {
  const runtime = httpRuntime(AutonomyLevel.Autonomous);
  const run = await runtime.run(
    "call",
    callEvent("ok404", { method: "GET", url: `${base}/missing`, okStatuses: [404] }),
  );
  assert.equal(run.results[0]?.outcome, "executed");
});

test("Shadow renders the request but makes no network call", async () => {
  const runtime = httpRuntime(AutonomyLevel.Shadow);
  const before = received.length;
  const run = await runtime.run("call", callEvent("shadow-1", { method: "POST", url: `${base}/x`, body: "hi" }));

  assert.equal(run.results[0]?.outcome, "predicted");
  assert.equal(run.results[0]?.rendered?.preview, `POST ${base}/x`);
  assert.equal(received.length, before, "no request was sent in Shadow");
});
