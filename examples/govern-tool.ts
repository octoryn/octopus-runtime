/**
 * Runnable example: govern a tool an agent already calls — without rewriting the
 * agent. Here the "tool" is shaped like a LangChain DynamicStructuredTool
 * (`{ name, description, func }`), but `governTool` wraps any async function.
 *
 *   tsx examples/govern-tool.ts
 */
import { AutonomyLevel, governTool } from "../src/index.js";

// A tool with a real side effect (imagine an HTTP POST). We count invocations so
// the example can prove the effect only fires when governance allows it.
let sends = 0;
const sendEmailTool = {
  name: "send_email",
  description: "Send an email to a recipient.",
  func: async (input: { to: string; subject: string }): Promise<{ id: string; to: string }> => {
    sends += 1;
    return { id: `msg_${sends}`, to: input.to };
  }
};

// Wrap the tool's func. The agent keeps calling `send_email`; the effect now
// passes through the autonomy gate — the real func runs only when it should.
function govern(level: AutonomyLevel, extra: Record<string, unknown> = {}) {
  return governTool(sendEmailTool.func, {
    name: sendEmailTool.name,
    autonomy: level,
    render: (input) => `would send "${input.subject}" to ${input.to}`,
    ...extra
  });
}

async function main(): Promise<void> {
  const input = { to: "user@example.com", subject: "Welcome" };

  for (const level of [AutonomyLevel.Observe, AutonomyLevel.Shadow] as const) {
    const r = await govern(level)(input);
    console.log(`${level.padEnd(10)} executed=${r.executed}  route=${r.route}  preview=${JSON.stringify(r.preview)}`);
  }

  // Draft: held for approval. Decline first, then approve.
  const declined = await govern(AutonomyLevel.Draft, { approve: () => false })(input);
  console.log(`draft(no)   executed=${declined.executed}  route=${declined.route}`);
  const approved = await govern(AutonomyLevel.Draft, { approve: () => true })(input);
  console.log(`draft(yes)  executed=${approved.executed}  route=${approved.route}`);

  // Autonomous: runs now.
  const auto = await govern(AutonomyLevel.Autonomous)(input);
  console.log(
    `autonomous  executed=${auto.executed}  route=${auto.route}  output=${JSON.stringify(auto.executed && auto.output)}`
  );

  // A ceiling (e.g. from an environment policy) caps Autonomous down to Shadow.
  const capped = await govern(AutonomyLevel.Autonomous, { ceiling: AutonomyLevel.Shadow })(input);
  console.log(`capped      executed=${capped.executed}  route=${capped.route}  (min(autonomous, shadow) = shadow)`);

  console.log(`\nreal sends: ${sends}  (only the two approved/autonomous paths ran the effect)`);
}

void main();
