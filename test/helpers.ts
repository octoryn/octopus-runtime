/**
 * Shared test helpers: a fully instrumented "probe" connector that counts
 * render/execute calls and can be told to throw, plus small builders for
 * events, workflows, and a runtime wired with a deterministic clock.
 */

import {
  createRuntime,
  defineConnector,
  defineAction,
  defineWorkflow,
  ManualClock,
  type AutonomyLevel,
  type Connector,
  type Condition,
  type Policy,
  type PlannedAction,
  type Runtime,
  type TriggerEvent,
  type Workflow,
} from "../src/index.js";
import * as s from "../src/schema.js";

export interface Probe {
  renderCalls: number;
  executeCalls: number;
  lastRenderedPayload: unknown;
  connector: Connector;
}

/** A connector whose render/execute are observable and optionally fail. */
export function probeConnector(opts: {
  renderThrows?: boolean;
  executeThrows?: boolean;
} = {}): Probe {
  const probe: Probe = {
    renderCalls: 0,
    executeCalls: 0,
    lastRenderedPayload: undefined,
    connector: undefined as unknown as Connector,
  };

  probe.connector = defineConnector({
    id: "probe",
    version: "1.0.0",
    actions: [
      defineAction({
        type: "probe.act",
        input: s.object({ value: s.string() }),
        render(input) {
          probe.renderCalls += 1;
          if (opts.renderThrows) throw new Error("render boom");
          probe.lastRenderedPayload = input;
          return { preview: `probe:${input.value}`, payload: input };
        },
        execute() {
          probe.executeCalls += 1;
          if (opts.executeThrows) throw new Error("execute boom");
          return { output: { ok: true }, effectRefs: [{ kind: "probe.effect", id: "e1" }] };
        },
      }),
    ],
  });

  return probe;
}

/** Build a single-action workflow at a given requested autonomy level. */
export function singleActionWorkflow(options: {
  id?: string;
  requestedAutonomy: AutonomyLevel;
  value?: string;
  conditions?: Condition[];
  policies?: Policy[];
}): Workflow {
  return defineWorkflow({
    id: options.id ?? "wf",
    match: (event) => event.source === "test",
    conditions: options.conditions ?? [],
    policies: options.policies ?? [],
    plan: () => [
      {
        ref: "a1",
        connectorId: "probe",
        actionType: "probe.act",
        requestedAutonomy: options.requestedAutonomy,
        input: { value: options.value ?? "hello" },
      },
    ],
  });
}

/** Build a workflow from an explicit action plan. */
export function planWorkflow(options: {
  id?: string;
  actions: PlannedAction[];
  policies?: Policy[];
  conditions?: Condition[];
}): Workflow {
  return defineWorkflow({
    id: options.id ?? "wf",
    match: (event) => event.source === "test",
    conditions: options.conditions ?? [],
    policies: options.policies ?? [],
    plan: () => options.actions,
  });
}

/** A test event on the `"test"` source. */
export function testEvent(payload: unknown = {}): TriggerEvent {
  return {
    id: "evt-1",
    source: "test",
    occurredAt: "2020-01-01T00:00:00.000Z",
    payload,
  };
}

/** A runtime wired with the given connectors/workflows and a deterministic clock. */
export function makeRuntime(connectors: Connector[], workflows: Workflow[]): Runtime {
  return createRuntime({ connectors, workflows, clock: new ManualClock() });
}
