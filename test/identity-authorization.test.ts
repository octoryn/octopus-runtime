/**
 * Identity & authorization ports (open seams A + B).
 *
 * These prove the seam is (1) additive — a runtime with no authorizer behaves
 * exactly as before; (2) real — a deny-authorizer actually blocks the decision
 * and prevents the effect, not just decorates it; (3) honestly defaulted —
 * `localIdentity`/`allowAll` are usable no-ops, not stubs; and (4) orthogonal to
 * autonomy — authorization gates *who* may act, never *how far* an action goes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createRuntime,
  AutonomyLevel,
  ManualClock,
  localIdentity,
  allowAll,
  LOCAL_PRINCIPAL,
  AuthorizationError,
  type Authorizer,
  type Principal
} from "../src/index.js";
import { probeConnector, singleActionWorkflow, testEvent } from "./helpers.js";

/** A runtime whose single action drafts (so it produces a pending approval). */
function draftRuntime(opts: { authorizer?: Authorizer } = {}) {
  const probe = probeConnector();
  const runtime = createRuntime({
    connectors: [probe.connector],
    workflows: [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Draft })],
    clock: new ManualClock(),
    ...(opts.authorizer ? { authorizer: opts.authorizer } : {})
  });
  return { probe, runtime };
}

/** Drive a run to its pending approval and return the approval id. */
async function pendingApproval(runtime: ReturnType<typeof draftRuntime>["runtime"]): Promise<string> {
  const run = await runtime.run("wf", testEvent());
  const approvalId = run.results[0]?.approvalId;
  assert.ok(approvalId, "a draft action creates a pending approval");
  return approvalId;
}

const alice: Principal = { id: "alice", roles: ["approver"], source: "test" };

// --- Defaults are real, not stubs ----------------------------------------

test("localIdentity authenticates to a stable, usable local principal", async () => {
  const p = await localIdentity.authenticate({ anything: "ignored" });
  assert.ok(p, "localIdentity always yields a principal");
  assert.equal(p.id, "local");
  assert.equal(p.source, "local");
  assert.deepEqual([...p.roles], ["owner"]);
  assert.equal(p, LOCAL_PRINCIPAL, "it is the exported LOCAL_PRINCIPAL");

  // A second call yields the same principal regardless of credential — a real
  // single-user default, not a per-call fabrication.
  const again = await localIdentity.authenticate(undefined);
  assert.equal(again, LOCAL_PRINCIPAL);
});

test("LOCAL_PRINCIPAL is frozen (cannot be mutated in place)", () => {
  assert.throws(() => {
    (LOCAL_PRINCIPAL as { id: string }).id = "hacked";
  }, TypeError);
});

test("allowAll permits every action, sync boolean true", () => {
  assert.equal(allowAll.can(alice, "approval.decide", { type: "approval", id: "x" }), true);
  assert.equal(allowAll.can(LOCAL_PRINCIPAL, "anything.at.all"), true);
});

// --- Additive: no authorizer means byte-identical behaviour ---------------

test("no authorizer configured: approvals resolve exactly as before (no principal needed)", async () => {
  const { probe, runtime } = draftRuntime();
  const approvalId = await pendingApproval(runtime);

  const result = await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });
  assert.equal(result.outcome, "executed");
  assert.equal(probe.executeCalls, 1);
});

test("allowAll authorizer is a true no-op: a decision with a principal still executes", async () => {
  const { probe, runtime } = draftRuntime({ authorizer: allowAll });
  const approvalId = await pendingApproval(runtime);

  const result = await runtime.resolveApproval(approvalId, {
    approved: true,
    decidedBy: "alice",
    principal: alice
  });
  assert.equal(result.outcome, "executed");
  assert.equal(probe.executeCalls, 1);
});

// --- Real gate: a deny-authorizer actually blocks -------------------------

test("deny-authorizer blocks the decision and the effect never runs", async () => {
  const denyAll: Authorizer = { can: () => false };
  const { probe, runtime } = draftRuntime({ authorizer: denyAll });
  const approvalId = await pendingApproval(runtime);

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: true, decidedBy: "mallory", principal: alice }),
    AuthorizationError
  );
  assert.equal(probe.executeCalls, 0, "a denied decision executes nothing");

  // The approval is untouched — still pending, re-decidable by an allowed actor.
  const approval = await runtime.read.getApproval(approvalId);
  assert.equal(approval?.status, "pending");
  assert.equal(approval?.decidedAt, undefined);
});

test("deny-authorizer also blocks a rejection (authorization gates the actor, not the verdict)", async () => {
  const denyAll: Authorizer = { can: () => false };
  const { probe, runtime } = draftRuntime({ authorizer: denyAll });
  const approvalId = await pendingApproval(runtime);

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: false, decidedBy: "mallory", principal: alice }),
    AuthorizationError
  );
  assert.equal(probe.executeCalls, 0);
  const approval = await runtime.read.getApproval(approvalId);
  assert.equal(approval?.status, "pending", "an unauthorized rejection changes nothing");
});

test("authorizer configured but no principal on the decision fails closed", async () => {
  const { probe, runtime } = draftRuntime({ authorizer: allowAll });
  const approvalId = await pendingApproval(runtime);

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" }),
    (err: unknown) => err instanceof AuthorizationError && /requires an authenticated principal/.test(err.message)
  );
  assert.equal(probe.executeCalls, 0, "a principal-less decision under an authorizer executes nothing");
  assert.equal((await runtime.read.getApproval(approvalId))?.status, "pending");
});

test("the authorizer sees the exact principal, action verb, and resource", async () => {
  const seen: Array<{ principal: Principal; action: string; resource?: { type: string; id: string } }> = [];
  const recording: Authorizer = {
    can: (principal, action, resource) => {
      seen.push({ principal, action, ...(resource ? { resource } : {}) });
      return true;
    }
  };
  const { runtime } = draftRuntime({ authorizer: recording });
  const approvalId = await pendingApproval(runtime);
  await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "alice", principal: alice });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.principal, alice);
  assert.equal(seen[0]?.action, "approval.decide");
  assert.deepEqual(seen[0]?.resource, { type: "approval", id: approvalId });
});

test("an async authorizer (Promise<boolean>) is awaited; async deny blocks", async () => {
  const asyncDeny: Authorizer = { can: () => Promise.resolve(false) };
  const { probe, runtime } = draftRuntime({ authorizer: asyncDeny });
  const approvalId = await pendingApproval(runtime);

  await assert.rejects(
    () => runtime.resolveApproval(approvalId, { approved: true, decidedBy: "x", principal: alice }),
    AuthorizationError
  );
  assert.equal(probe.executeCalls, 0);
});

test("a role-gated authorizer permits the allowed principal and denies others", async () => {
  const rbac: Authorizer = { can: (p, action) => action === "approval.decide" && p.roles.includes("approver") };
  const { probe, runtime } = draftRuntime({ authorizer: rbac });

  // Denied: principal without the role.
  const first = await pendingApproval(runtime);
  await assert.rejects(
    () =>
      runtime.resolveApproval(first, {
        approved: true,
        decidedBy: "bob",
        principal: { id: "bob", roles: ["viewer"], source: "test" }
      }),
    AuthorizationError
  );
  assert.equal(probe.executeCalls, 0);

  // Allowed: same approval, an approver decides it.
  const result = await runtime.resolveApproval(first, { approved: true, decidedBy: "alice", principal: alice });
  assert.equal(result.outcome, "executed");
  assert.equal(probe.executeCalls, 1);
});

// --- Verified attribution: the recorded actor is the authenticated one ----

test("with a principal, the approval + audit attribute the decision to principal.id, not the caller's decidedBy", async () => {
  const { runtime } = draftRuntime({ authorizer: allowAll });
  const approvalId = await pendingApproval(runtime);

  // A caller authorized as alice tries to stamp the record as someone else.
  await runtime.resolveApproval(approvalId, {
    approved: true,
    decidedBy: "ceo@corp", // unverified free-text — must NOT become the attribution
    principal: alice
  });

  const approval = await runtime.read.getApproval(approvalId);
  assert.ok(approval);
  assert.equal(approval.decidedBy, "alice", "the verified principal.id is the recorded attribution");

  const audit = await runtime.read.getAuditTrail(approval.runId);
  const decided = audit.find((r) => r.event === "approval.decided");
  assert.equal(
    (decided?.detail as { decidedBy?: string })?.decidedBy,
    "alice",
    "the audit trail attributes the decision to the authenticated identity"
  );
});

test("without a principal, decidedBy remains the attribution (unchanged behaviour)", async () => {
  const { runtime } = draftRuntime(); // no authorizer, no principal
  const approvalId = await pendingApproval(runtime);
  await runtime.resolveApproval(approvalId, { approved: true, decidedBy: "ops" });

  const approval = await runtime.read.getApproval(approvalId);
  assert.equal(approval?.decidedBy, "ops", "legacy callers are attributed by decidedBy exactly as before");
});

// --- Orthogonal to autonomy ----------------------------------------------

test("authorization is orthogonal to autonomy: a deny-authorizer does not touch autonomous routing", async () => {
  // An Autonomous action never creates an approval, so the approval-decide gate
  // is never consulted — proving the authorizer governs *who decides*, not *how
  // far an action goes*. A deny-all authorizer must not block an autonomous run.
  const probe = probeConnector();
  const runtime = createRuntime({
    connectors: [probe.connector],
    workflows: [singleActionWorkflow({ requestedAutonomy: AutonomyLevel.Autonomous })],
    clock: new ManualClock(),
    authorizer: { can: () => false }
  });

  const run = await runtime.run("wf", testEvent());
  assert.equal(run.results[0]?.outcome, "executed");
  assert.equal(probe.executeCalls, 1, "autonomy routing is unaffected by the authorizer");
});
