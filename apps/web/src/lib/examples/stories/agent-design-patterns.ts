import type { ExampleStory } from "../types";

export const agentDesignPatterns: ExampleStory = {
  slug: "agent-design-patterns",
  section: "agents",
  title: "Agent Design Patterns",
  tagline:
    "Pick the right shape for an agent app from building blocks you already know: keys and actors calling actors.",
  ideas: [
    "The key decides what an agent remembers: per user, per thread, or per task.",
    "Agents call other agents like any actor. Wait for the answer, or send and move on.",
    "Workflows, crons, and webhooks drive the same agent. A requestId makes a redelivery safe.",
  ],
  docs: "https://rivet.dev/guides/agent-design-patterns/",
  requires: [
    {
      label: "@rivet-dev/pi + @earendil-works/pi-durable",
      detail:
        "Every agent here is a pi() actor. Tools use @earendil-works/pi-schema.",
    },
    {
      label: "@rivet-dev/sandbox-adapter + E2B",
      detail: "The coding agents run their tools in an E2B sandbox.",
    },
    {
      label: "@rivet-dev/workflows",
      detail: "Only for the agent-as-a-workflow-step pattern.",
    },
    {
      label: "ANTHROPIC_API_KEY, OPENAI_API_KEY",
      detail:
        "The examples mix Anthropic and OpenAI models. GITHUB_TOKEN for the pull request tool.",
    },
  ],
  nodes: [
    { id: "app", label: "your backend", kind: "client", x: 14, y: 30 },
    {
      id: "support",
      label: "support",
      kind: "agent",
      key: "ticket-4821",
      x: 46,
      y: 13,
    },
    {
      id: "engineering",
      label: "engineering",
      kind: "agent",
      key: "memo id",
      x: 82,
      y: 13,
    },
    { id: "agent", label: "agent", kind: "agent", x: 46, y: 47 },
    {
      id: "reviewer",
      label: "reviewer",
      kind: "agent",
      key: "acme/app",
      x: 82,
      y: 47,
    },
    {
      id: "flaky",
      label: "flakyTest",
      kind: "actor",
      key: "acme/app, 2026-10-01",
      x: 46,
      y: 13,
    },
    {
      id: "creds",
      label: "credentials",
      kind: "actor",
      key: "tenant-a",
      x: 82,
      y: 13,
    },
  ],
  edges: [
    { id: "app-support", from: "app", to: "support" },
    { id: "support-engineering", from: "support", to: "engineering" },
    { id: "app-agent", from: "app", to: "agent" },
    { id: "agent-reviewer", from: "agent", to: "reviewer" },
    { id: "app-flaky", from: "app", to: "flaky" },
    { id: "flaky-agent", from: "flaky", to: "agent" },
    { id: "app-creds", from: "app", to: "creds" },
    { id: "agent-creds", from: "agent", to: "creds" },
  ],
  beats: [
    {
      title: "The key decides the memory.",
      body: "The key picks which conversation a prompt continues. A support ticket is one thread, so its key is the ticket id. Keys are arrays, so ids from a webhook cannot break their shape.",
      enter: ["app", "support"],
      focus: ["support"],
      status: { support: "per thread" },
      flows: [{ edge: "app-support", label: "prompt()" }],
      panel: {
        kind: "state",
        title: "pick the key from what it remembers",
        rows: [
          ["assistant [userId]", "everything a user asked"],
          ["slackThread [channel, threadTs]", "one thread"],
          ["support [ticketId]", "one ticket"],
          ["issueFixer [repo, issue]", "one task, then destroy"],
        ],
      },
    },
    {
      title: "Lead agent with subagents.",
      body: "The support agent hands one focused question to a specialist with ask_specialist and waits. The specialist starts with a fresh context, so only its answer comes back.",
      enter: ["engineering"],
      focus: ["support", "engineering"],
      status: { support: "waiting", engineering: "fresh context" },
      flows: [{ edge: "support-engineering", label: "ask_specialist" }],
      panel: {
        kind: "chat",
        title: "support · ticket-4821",
        messages: [
          {
            role: "user",
            text: "Order 1042 shows as delivered but never arrived, and the tracking page throws a 500 error.",
          },
          {
            role: "tool",
            text: 'ask_specialist { specialist: "engineering", question: "Why does /track/1042 return 500?" }',
          },
          {
            role: "assistant",
            text: "Engineering found the cause of the tracking error. Checking the order next.",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Send instead of waiting.",
      body: "When the sender does not need the answer, it sends a message. The coder calls requestReview on the reviewer, which queues its own prompt and returns. The review survives the coder going away.",
      exit: ["support", "engineering"],
      enter: ["agent", "reviewer"],
      focus: ["agent", "reviewer"],
      status: { agent: "moves on", reviewer: "reviewing" },
      flows: [{ edge: "agent-reviewer", label: "requestReview()" }],
      panel: {
        kind: "state",
        title: "coder → reviewer",
        rows: [
          ["coder key", "[acme/app, fix-flaky-checkout-test]"],
          ["request_review", "returns once the request is saved"],
          ["reviewer", "submits to BACKGROUND_CONTEXT"],
          ["coder waits", "no"],
        ],
      },
    },
    {
      title: "An agent as a workflow step.",
      body: "When the work has fixed steps, waits, or retries, a workflow drives the agent. Each step prompts it with a fixed requestId, so a retried step waits for the first attempt's run.",
      exit: ["reviewer"],
      enter: ["flaky"],
      focus: ["flaky", "agent"],
      status: { flaky: "second-run", agent: "running tests" },
      flows: [{ edge: "flaky-agent", label: "prompt(second-run)" }],
      panel: {
        kind: "state",
        title: "flakyTest · acme/app, 2026-10-01",
        rows: [
          ["first-run", "done"],
          ["wait-before-rerun", "slept 10 min"],
          ["second-run", "running"],
          ["requestId", "<actorId>:second-run"],
          ["report", "null until second-run ends"],
        ],
      },
    },
    {
      title: "A scheduled agent.",
      body: "The first getOrCreate creates the agent, and onCreate sets a cron. It wakes at 9:00 each day, runs the suite, and sleeps between runs. Read the summary from its conversation.",
      exit: ["flaky"],
      focus: ["agent"],
      status: { agent: "cron 9:00" },
      flows: [{ edge: "app-agent", label: "conversation.context()" }],
      panel: {
        kind: "state",
        title: "agent · acme/app, morning-triage",
        rows: [
          ["cron", "morning-triage"],
          ["expression", "0 9 * * *"],
          ["action", "prompt"],
          ["between runs", "asleep"],
        ],
      },
    },
    {
      title: "Webhooks that must finish.",
      body: "A webhook starts the run with conversation.submit and the delivery id as its requestId. GitHub's redelivery returns the first submission, so the work and its side effects happen once.",
      focus: ["app", "agent"],
      status: { agent: "one run" },
      flows: [{ edge: "app-agent", label: "conversation.submit" }],
      panel: {
        kind: "terminal",
        title: "your backend",
        lines: [
          {
            text: "POST /github  issues.labeled  delivery 7f3a",
            tone: "command",
          },
          {
            text: "submit fixer [acme/app, 1042]  requestId 7f3a  saved",
            tone: "ok",
          },
          {
            text: "POST /github  issues.labeled  delivery 7f3a (redelivery)",
            tone: "command",
          },
          {
            text: "submit requestId 7f3a  returns first submission",
            tone: "muted",
          },
          { text: "runs started: 1", tone: "ok" },
        ],
      },
    },
    {
      title: "Credentials shared per tenant.",
      body: "Agent keys start with the tenant id, and the agent picks its credentials actor from it. Every agent in a tenant shares one set of model logins and never sees another tenant's.",
      enter: ["creds"],
      focus: ["agent", "creds"],
      status: { agent: "tenant-a", creds: "tenant-a" },
      flows: [
        { edge: "app-creds", label: 'save("anthropic")' },
        { edge: "agent-creds", label: "read()" },
      ],
      panel: {
        kind: "state",
        title: "which credentials each agent reads",
        rows: [
          ["agent [tenant-a, user-1]", "credentials [tenant-a]"],
          ["agent [tenant-a, user-2]", "credentials [tenant-a]"],
          ["agent [tenant-b, user-9]", "credentials [tenant-b]"],
        ],
      },
    },
  ],
  code: [
    {
      name: "keys.ts",
      note: "Three agents, three key shapes: per user, per thread, per task.",
      source: `const client = createClient<typeof registry>();

// Per user: remembers everything a user has asked, across every chat.
export async function chat(userId: string, message: string) {
  const result = await client.assistant.getOrCreate([userId]).prompt(message);
  return result.status === "done" ? result.text : undefined;
}

// Per thread: each Slack thread is its own conversation.
export async function onSlackMessage(channel: string, threadTs: string, text: string) {
  const result = await client.slackThread.getOrCreate([channel, threadTs]).prompt(text);
  return result.status === "done" ? result.text : undefined;
}

// Per task: starts fresh in its own sandbox, then finish() destroys it.
export async function onIssueLabeled(repo: string, issue: { number: number; title: string; body: string }) {
  const fixer = client.issueFixer.getOrCreate([repo, String(issue.number)]);
  try {
    const result = await fixer.prompt(
      \`Clone https://github.com/\${repo}, fix issue #\${issue.number}, and open a pull request.\\n\\n# \${issue.title}\\n\\n\${issue.body}\`,
    );
    return result.status === "done" ? result.text : undefined;
  } finally {
    await fixer.finish();
  }
}`,
    },
    {
      name: "specialists.ts",
      note: "The lead's tool. A memo keeps a rerun on the same specialist.",
      source: `export const askSpecialist = defineTool({
  name: "ask_specialist",
  description:
    "Hand one focused question to a specialist and get its answer. Use orders for order status, refunds, and shipping. Use engineering for bugs that need someone to read or run the code.",
  parameters: obj({
    specialist: oneOf(["orders", "engineering"]),
    question: str({ description: "Everything the specialist needs. It can't see this conversation." }),
  }),
  // A rerun reaches the same specialist Actor, through the memo below.
  replay: "safe",
  execute: async ({ specialist, question }, api, context) => {
    // The memo is saved with this tool call, so a rerun gets the same id.
    const id = await api.memo("specialist-id", crypto.randomUUID(), context);
    const agent = client[specialist].getOrCreate([id]);
    context.abortSignal?.addEventListener("abort", () => void agent.conversation.abort(ROOT_CONVERSATION_ID));
    const result = await agent.prompt(question, { requestId: id });
    if (result.status === "unanswered") {
      return { output: [{ type: "text", text: \`The specialist did not answer: \${result.reason}\` }], isError: true };
    }
    const answer = result.text || "The specialist finished without an answer.";
    return { output: [{ type: "text", text: answer }], details: { specialist } };
  },
});`,
    },
    {
      name: "triggers.ts",
      note: "A webhook deduped by its delivery id, and an agent that schedules itself.",
      source: `// Called from a GitHub webhook. GitHub redelivers a webhook that times out,
// so the delivery id makes a redelivery return the first submission.
export async function onIssueLabeled(repo: string, issue: number, title: string, deliveryId: string) {
  const fixer = client.fixer.getOrCreate([repo, String(issue)]);
  const root = await fixer.harness.root();
  await fixer.conversation.submit(root.id, {
    type: "input",
    content: \`Fix issue #\${issue} in \${repo}: \${title}. Push a branch and open a pull request.\`,
    requestId: deliveryId,
  });
}

// The scheduled agent sets its own cron when it is first created.
const agent = pi({
  model: "anthropic/claude-sonnet-5-5",
  registry: extensions,
  sandbox: e2bProvider(),
  onCreate: async (c) => {
    const [repo] = c.key;
    await c.cron.set({
      name: "morning-triage",
      expression: "0 9 * * *",
      action: "prompt",
      args: [\`Clone https://github.com/\${repo}, run its test suite, and summarize any failures.\`],
    });
  },
});`,
    },
  ],
};
