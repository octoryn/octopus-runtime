#!/usr/bin/env node
/**
 * A small CLI for inspecting runtime behavior. It runs a built-in demo workflow
 * (a welcome email on signup) at a chosen autonomy level and prints the run
 * record and full audit trail as JSON.
 *
 *   workflow-runtime demo autonomous
 *   workflow-runtime demo draft
 *
 * State is in-memory per process, so this is for demonstration and inspection,
 * not a long-running server.
 */

import { createRuntime, defineWorkflow, matchSource, AutonomyLevel } from "./index.js";
import type { AutonomyLevel as AutonomyLevelType } from "./index.js";
import { createEmailConnector, inMemoryTransport } from "./connectors/email.js";

const USAGE = `workflow-runtime — governed execution runtime

Usage:
  workflow-runtime demo [observe|shadow|draft|autonomous]   Run the demo workflow
  workflow-runtime help                                     Show this help

The demo emits a signup event to a "welcome email" workflow and prints the
resulting run record and audit trail as JSON.`;

function parseLevel(arg: string | undefined): AutonomyLevelType {
  switch (arg) {
    case "observe":
      return AutonomyLevel.Observe;
    case "shadow":
      return AutonomyLevel.Shadow;
    case "draft":
      return AutonomyLevel.Draft;
    case undefined:
    case "autonomous":
      return AutonomyLevel.Autonomous;
    default:
      throw new Error(`unknown autonomy level "${arg}" (expected observe|shadow|draft|autonomous)`);
  }
}

async function demo(levelArg: string | undefined): Promise<void> {
  const level = parseLevel(levelArg);
  const { transport, outbox } = inMemoryTransport();

  const runtime = createRuntime({
    connectors: [createEmailConnector(transport)],
    workflows: [
      defineWorkflow<{ email: string }>({
        id: "welcome-email",
        match: matchSource("signup"),
        plan: ({ event }) => [
          {
            ref: "send-welcome",
            connectorId: "email",
            actionType: "email.send",
            requestedAutonomy: level,
            input: { to: [event.payload.email], subject: "Welcome!", body: "Thanks for joining." }
          }
        ]
      })
    ]
  });

  const run = await runtime.run("welcome-email", {
    id: "evt-1",
    source: "signup",
    occurredAt: new Date().toISOString(),
    payload: { email: "ada@example.com" }
  });

  const audit = await runtime.read.getAuditTrail(run.id);
  console.log(
    JSON.stringify(
      {
        run,
        audit,
        outbox
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "demo":
      await demo(rest[0]);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
