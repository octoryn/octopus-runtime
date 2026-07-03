import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AutonomyLevel,
  decisionEvidence,
  governTool,
  verifyEvidence,
  type GovernedResult,
  type RoutingDecision
} from "../src/index.js";

/** A fixed clock so evidence timestamps are deterministic under test. */
const fixedClock = { now: (): Date => new Date("2026-07-03T00:00:00.000Z") };

/** A tool with a spy so we can tie `content.executed` to whether the effect ran. */
function spyTool() {
  let calls = 0;
  const fn = (input: { x: number }): { doubled: number } => {
    calls += 1;
    return { doubled: input.x * 2 };
  };
  return { fn, calls: () => calls };
}

/**
 * Produce a real routing decision for a given governTool configuration, and the
 * spy so a test can assert whether the effect actually ran.
 */
async function routeOf(
  opts: Parameters<typeof governTool<{ x: number }, { doubled: number }>>[1]
): Promise<{ decision: RoutingDecision<{ doubled: number }>; ran: boolean }> {
  const t = spyTool();
  const governed = governTool(t.fn, { name: "double", ...opts });
  const decision = await governed({ x: 21 });
  return { decision, ran: t.calls() > 0 };
}

test("observe → verifiable evidence, kind reflects the route, content.executed is false", async () => {
  const { decision, ran } = await routeOf({ autonomy: AutonomyLevel.Observe });
  const ev = decisionEvidence(decision, { clock: fixedClock });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:observe");
  assert.equal((ev.content as { executed: boolean }).executed, false);
  assert.equal((ev.content as { executed: boolean }).executed, ran);
  assert.deepEqual(ev.subject, [{ type: "tool", id: "double" }]);
  assert.equal(ev.provenance.source, "octopus-runtime");
  assert.equal(ev.provenance.method, "autonomy-gate");
  assert.equal(ev.provenance.at, "2026-07-03T00:00:00.000Z");
});

test("shadow → verifiable, kind reflects route, preview is carried, not executed", async () => {
  const { decision, ran } = await routeOf({
    autonomy: AutonomyLevel.Shadow,
    render: (input) => `would double ${input.x}`
  });
  const ev = decisionEvidence(decision, { clock: fixedClock });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:shadow");
  assert.equal((ev.content as { executed: boolean }).executed, false);
  assert.equal((ev.content as { executed: boolean }).executed, ran);
  assert.equal((ev.content as { preview: string }).preview, "would double 21");
});

test("draft declined → verifiable, kind is draft, content.executed matches (false)", async () => {
  const { decision, ran } = await routeOf({ autonomy: AutonomyLevel.Draft, approve: () => false });
  assert.equal(ran, false);
  const ev = decisionEvidence(decision, { clock: fixedClock });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:draft");
  assert.equal((ev.content as { executed: boolean }).executed, false);
  assert.equal((ev.content as { executed: boolean }).executed, ran);
});

test("draft approved → verifiable, kind is draft, content.executed matches (true)", async () => {
  const { decision, ran } = await routeOf({ autonomy: AutonomyLevel.Draft, approve: () => true });
  assert.equal(ran, true);
  const ev = decisionEvidence(decision, { clock: fixedClock });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:draft");
  assert.equal((ev.content as { executed: boolean }).executed, true);
  assert.equal((ev.content as { executed: boolean }).executed, ran);
});

test("autonomous → verifiable, kind is autonomous, content.executed matches (true)", async () => {
  const { decision, ran } = await routeOf({ autonomy: AutonomyLevel.Autonomous });
  assert.equal(ran, true);
  const ev = decisionEvidence(decision, {
    clock: fixedClock,
    requestedAutonomy: AutonomyLevel.Autonomous
  });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:autonomous");
  assert.equal((ev.content as { executed: boolean }).executed, true);
  assert.equal((ev.content as { executed: boolean }).executed, ran);
  assert.equal((ev.content as { requestedAutonomy: string }).requestedAutonomy, AutonomyLevel.Autonomous);
});

test("ceiling-capped → effective level and route reflect the cap, effect never ran", async () => {
  // Requested Autonomous but capped at Shadow → effective Shadow → never runs.
  const { decision, ran } = await routeOf({
    autonomy: AutonomyLevel.Autonomous,
    ceiling: AutonomyLevel.Shadow
  });
  assert.equal(ran, false);
  const ev = decisionEvidence(decision, {
    clock: fixedClock,
    requestedAutonomy: AutonomyLevel.Autonomous,
    ceiling: AutonomyLevel.Shadow
  });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.kind, "governed-decision:shadow");
  const content = ev.content as {
    executed: boolean;
    requestedAutonomy: string;
    ceiling: string;
    effectiveAutonomy: string;
  };
  assert.equal(content.executed, false);
  assert.equal(content.executed, ran);
  assert.equal(content.requestedAutonomy, AutonomyLevel.Autonomous);
  assert.equal(content.ceiling, AutonomyLevel.Shadow);
  assert.equal(content.effectiveAutonomy, AutonomyLevel.Shadow);
});

test("integritySecret round-trip: verifies with the key, fails without it", async () => {
  const { decision } = await routeOf({ autonomy: AutonomyLevel.Autonomous });
  const secret = "eu-ai-act-art-12";
  const ev = decisionEvidence(decision, { clock: fixedClock, integritySecret: secret });

  assert.equal(verifyEvidence(ev, secret), true, "verifies with the key");
  assert.equal(verifyEvidence(ev), false, "fails without the key");
  assert.equal(verifyEvidence(ev, "wrong-key"), false, "fails with the wrong key");
});

test("deterministic: two identical decisions at the same clock → byte-identical evidence", async () => {
  // Two structurally identical routing decisions.
  const a: RoutingDecision<{ ok: true }> = {
    executed: true,
    route: "autonomous",
    level: AutonomyLevel.Autonomous,
    output: { ok: true },
    name: "notify"
  };
  const b: RoutingDecision<{ ok: true }> = {
    executed: true,
    route: "autonomous",
    level: AutonomyLevel.Autonomous,
    output: { ok: true },
    name: "notify"
  };

  const ev1 = decisionEvidence(a, { clock: fixedClock, requestedAutonomy: AutonomyLevel.Autonomous });
  const ev2 = decisionEvidence(b, { clock: fixedClock, requestedAutonomy: AutonomyLevel.Autonomous });

  assert.deepEqual(ev1, ev2);
  assert.equal(ev1.id, ev2.id);
  assert.equal(ev1.integrity, ev2.integrity);
  assert.equal(JSON.stringify(ev1), JSON.stringify(ev2));
});

test("an explicit `at` and an injected actor are recorded and verifiable", async () => {
  const decision: GovernedResult<never> = {
    executed: false,
    route: "observe",
    level: AutonomyLevel.Observe,
    name: "wire-transfer"
  };
  const ev = decisionEvidence(decision, {
    at: "2026-01-01T12:00:00.000Z",
    actor: { type: "agent", id: "assistant-7" },
    reason: "watch-only environment"
  });

  assert.equal(verifyEvidence(ev), true);
  assert.equal(ev.provenance.at, "2026-01-01T12:00:00.000Z");
  assert.deepEqual(ev.actor, { type: "agent", id: "assistant-7" });
  assert.equal((ev.content as { reason: string }).reason, "watch-only environment");
});

test("decisionEvidence never throws on a non-JSON preview — the audit record survives", async () => {
  // Regression: a caller `render` can return anything. A preview containing a
  // non-finite number (e.g. a ratio over zero), an undefined optional field, or
  // a bigint used to crash createEvidence with an uncaught TypeError, losing the
  // whole decision. The record must survive, lossily coercing the preview.
  const t = spyTool();
  const governed = governTool(t.fn, {
    name: "double",
    autonomy: AutonomyLevel.Shadow, // a non-executing route, so `render` runs
    render: (input: { x: number }) => ({
      ratio: input.x / 0, // Infinity → null
      missing: undefined, // dropped
      big: 10n, // bigint → "10"
      note: "held"
    })
  });
  const decision = await governed({ x: 21 });

  // A throw here (the regression) fails the test.
  const ev = decisionEvidence(decision, { clock: fixedClock });
  assert.equal(verifyEvidence(ev), true);
  const preview = (ev.content as { preview?: Record<string, unknown> }).preview ?? {};
  assert.equal(preview.ratio, null); // non-finite coerced
  assert.equal(preview.big, "10"); // bigint stringified
  assert.equal(preview.note, "held");
  assert.ok(!("missing" in preview)); // undefined omitted
});

test("decisionEvidence never throws on a self-referential (cyclic) preview", async () => {
  const cyclic: Record<string, unknown> = { label: "loop" };
  cyclic.self = cyclic;
  const t = spyTool();
  const governed = governTool(t.fn, {
    name: "double",
    autonomy: AutonomyLevel.Shadow,
    render: () => cyclic
  });
  const decision = await governed({ x: 1 });
  // A throw here (the regression) fails the test.
  const ev = decisionEvidence(decision, { clock: fixedClock });
  assert.equal(verifyEvidence(ev), true);
  const preview = (ev.content as { preview?: Record<string, unknown> }).preview ?? {};
  assert.equal(preview.label, "loop"); // cycle broken, rest preserved
  assert.ok(!("self" in preview));
});
