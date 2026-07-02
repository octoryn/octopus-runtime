/**
 * Runnable example: one workflow, one connector, all four autonomy levels.
 *
 *   npm run example
 *
 * It sends a "welcome email" for a signup event, and shows how the same
 * workflow behaves at Observe, Shadow, Draft, and Autonomous — plus resolving
 * a Draft approval so the held effect finally executes.
 */

import {
  createRuntime,
  defineWorkflow,
  matchSource,
  AutonomyLevel,
  ManualClock,
  type AutonomyLevel as AutonomyLevelType,
  type TriggerEvent
} from "../src/index.js";
import { createEmailConnector, inMemoryTransport } from "../src/connectors/email.js";

interface SignupPayload {
  email: string;
  name: string;
  autonomy: AutonomyLevelType;
}

const { transport, outbox } = inMemoryTransport();
const email = createEmailConnector(transport);

const welcome = defineWorkflow<SignupPayload>({
  id: "welcome-email",
  name: "Send a welcome email on signup",
  match: matchSource("signup"),
  conditions: [{ id: "has-email", test: ({ event }) => event.payload.email.includes("@") }],
  plan: ({ event }) => [
    {
      ref: "send-welcome",
      connectorId: "email",
      actionType: "email.send",
      requestedAutonomy: event.payload.autonomy,
      input: {
        to: [event.payload.email],
        subject: `Welcome, ${event.payload.name}!`,
        body: "Thanks for signing up."
      }
    }
  ]
});

const runtime = createRuntime({
  connectors: [email],
  workflows: [welcome],
  clock: new ManualClock()
});

function signup(autonomy: AutonomyLevelType): TriggerEvent<SignupPayload> {
  return {
    id: `evt-${autonomy}`,
    source: "signup",
    occurredAt: new Date("2020-01-01T00:00:00Z").toISOString(),
    payload: { email: "ada@example.com", name: "Ada", autonomy }
  };
}

async function main(): Promise<void> {
  for (const level of [AutonomyLevel.Observe, AutonomyLevel.Shadow, AutonomyLevel.Draft, AutonomyLevel.Autonomous]) {
    const run = await runtime.run("welcome-email", signup(level));
    const result = run.results[0];
    console.log(
      `[${level.padEnd(10)}] outcome=${result?.outcome}` +
        (result?.rendered ? ` | rendered="${result.rendered.preview}"` : "") +
        (result?.approvalId ? ` | approval=${result.approvalId}` : "")
    );
  }

  console.log(`\nOutbox after four runs: ${outbox.length} email(s) sent.`);
  console.log("(Only the Autonomous run executed. Observe/Shadow/Draft sent nothing.)\n");

  // Resolve the pending Draft approval — now, and only now, its effect executes.
  const [pending] = await runtime.read.listPendingApprovals();
  if (pending) {
    console.log(`Approving held draft: "${pending.rendered.preview}"`);
    const executed = await runtime.resolveApproval(pending.id, {
      approved: true,
      decidedBy: "ops@example.com"
    });
    console.log(`  -> outcome=${executed.outcome}`);
  }

  console.log(`\nOutbox after approval: ${outbox.length} email(s) sent.`);
  for (const sent of outbox) {
    console.log(`  • ${sent.messageId} → ${sent.to.join(", ")} (${sent.subject})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
