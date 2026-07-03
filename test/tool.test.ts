import { test } from "node:test";
import assert from "node:assert/strict";
import { AutonomyLevel, governTool } from "../src/index.js";

/** A tool with a spy so we can assert the side effect only fires when allowed. */
function spyTool() {
  let calls = 0;
  const fn = (input: { x: number }): { doubled: number } => {
    calls += 1;
    return { doubled: input.x * 2 };
  };
  return { fn, calls: () => calls };
}

test("observe never calls the tool", async () => {
  const t = spyTool();
  const governed = governTool(t.fn, { autonomy: AutonomyLevel.Observe });
  const r = await governed({ x: 21 });
  assert.equal(r.executed, false);
  assert.equal(r.route, "observe");
  assert.equal(t.calls(), 0);
});

test("shadow never calls the tool but can render a preview", async () => {
  const t = spyTool();
  const governed = governTool(t.fn, {
    autonomy: AutonomyLevel.Shadow,
    render: (input) => `would double ${input.x}`
  });
  const r = await governed({ x: 21 });
  assert.equal(r.executed, false);
  assert.equal(r.route, "shadow");
  assert.equal(r.preview, "would double 21");
  assert.equal(t.calls(), 0);
});

test("autonomous executes and returns the output", async () => {
  const t = spyTool();
  const governed = governTool(t.fn, { autonomy: AutonomyLevel.Autonomous });
  const r = await governed({ x: 21 });
  assert.equal(r.executed, true);
  assert.equal(r.route, "autonomous");
  assert.deepEqual(r.executed && r.output, { doubled: 42 });
  assert.equal(t.calls(), 1);
});

test("draft executes only after an approval returns true", async () => {
  const t = spyTool();
  const declined = governTool(t.fn, { autonomy: AutonomyLevel.Draft, approve: () => false });
  assert.equal((await declined({ x: 1 })).executed, false);
  assert.equal(t.calls(), 0);

  const approved = governTool(t.fn, { autonomy: AutonomyLevel.Draft, approve: () => true });
  const r = await approved({ x: 5 });
  assert.equal(r.executed, true);
  assert.equal(r.route, "draft");
  assert.equal(t.calls(), 1);
});

test("draft with no approver never executes", async () => {
  const t = spyTool();
  const governed = governTool(t.fn, { autonomy: AutonomyLevel.Draft });
  assert.equal((await governed({ x: 1 })).executed, false);
  assert.equal(t.calls(), 0);
});

test("a ceiling caps autonomy to the more restrictive level (min)", async () => {
  const t = spyTool();
  // Requested Autonomous, but capped at Shadow → effective Shadow → never runs.
  const governed = governTool(t.fn, { autonomy: AutonomyLevel.Autonomous, ceiling: AutonomyLevel.Shadow });
  const r = await governed({ x: 1 });
  assert.equal(r.executed, false);
  assert.equal(r.level, AutonomyLevel.Shadow);
  assert.equal(t.calls(), 0);
});

test("requiresApproval downgrades autonomous to a gated draft", async () => {
  const t = spyTool();
  const governed = governTool(t.fn, { autonomy: AutonomyLevel.Autonomous, requiresApproval: true });
  const r = await governed({ x: 1 }); // no approver → not executed
  assert.equal(r.executed, false);
  assert.equal(r.route, "draft");
  assert.equal(t.calls(), 0);
});
