import type { ExampleStory } from "../types";

const job =
  "Compare SQLite, Postgres, and DuckDB for an analytics dashboard with 50 million rows.";

export const multiAgentSystems: ExampleStory = {
  slug: "multi-agent-systems",
  section: "agents",
  title: "Multi-Agent Systems",
  tagline:
    "Split one job across specialist agents that work in parallel and survive a crash.",
  ideas: [
    "One ask_specialist call fans out to one researcher per subtask and waits for every answer.",
    "Memoized researcher ids and requestIds make a rerun reach the same researchers, not new ones.",
    "The orchestrator hands its report to a reviewer from onAnswer and does not wait for the review.",
  ],
  docs: "https://rivet.dev/guides/multi-agent-system/",
  requires: [
    {
      label: "@rivet-dev/pi",
      detail:
        "With @earendil-works/pi-durable, pi-ai, pi-schema, and chord for the three agents and their tools.",
    },
    {
      label: "rivetkit",
      detail: "Actors, the registry, and the client. This repo targets 3.1.1.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "The orchestrator runs on anthropic/claude-opus-5-5.",
    },
    {
      label: "OPENAI_API_KEY",
      detail:
        "Researchers run on openai/gpt-5.4-mini, the reviewer on openai/gpt-5.5.",
    },
  ],
  nodes: [
    { id: "app", label: "your app", kind: "client", x: 14, y: 30 },
    {
      id: "orch",
      label: "orchestrator",
      kind: "agent",
      key: "job-81",
      x: 42,
      y: 20,
    },
    {
      id: "r1",
      label: "researcher",
      kind: "agent",
      key: "a41c… SQLite",
      x: 78,
      y: 11,
    },
    {
      id: "r2",
      label: "researcher",
      kind: "agent",
      key: "6e0b… Postgres",
      x: 78,
      y: 29,
    },
    {
      id: "r3",
      label: "researcher",
      kind: "agent",
      key: "d93f… DuckDB",
      x: 78,
      y: 47,
    },
    {
      id: "reviewer",
      label: "reviewer",
      kind: "agent",
      key: "job-81",
      x: 42,
      y: 48,
    },
  ],
  edges: [
    { id: "app-orch", from: "app", to: "orch" },
    { id: "orch-r1", from: "orch", to: "r1" },
    { id: "orch-r2", from: "orch", to: "r2" },
    { id: "orch-r3", from: "orch", to: "r3" },
    { id: "orch-reviewer", from: "orch", to: "reviewer" },
    { id: "app-reviewer", from: "app", to: "reviewer" },
  ],
  beats: [
    {
      title: "Start a job.",
      body: "Your app picks a job id and calls submit on that job's orchestrator. The job id is also the requestId, so a retried call starts the job once.",
      enter: ["app", "orch"],
      focus: ["app", "orch"],
      status: { orch: "planning" },
      flows: [{ edge: "app-orch", label: "submit(job, { requestId: jobId })" }],
      panel: {
        kind: "terminal",
        title: "client.ts",
        lines: [
          { text: "npx tsx client.ts", tone: "command" },
          { text: "Started job job-81", tone: "ok" },
          { text: "submit returned. The job runs on its own.", tone: "muted" },
        ],
      },
    },
    {
      title: "Split into subtasks.",
      body: "The model writes its plan as a list of subtasks and sends them all to ask_specialist in one call. api.memo saves one researcher id per subtask with the tool call.",
      focus: ["orch"],
      status: { orch: "ask_specialist" },
      panel: {
        kind: "state",
        title: "ask_specialist · job-81",
        rows: [
          ["subtask 1", "SQLite at 50M rows for dashboards"],
          ["subtask 2", "Postgres at 50M rows for dashboards"],
          ["subtask 3", "DuckDB at 50M rows for dashboards"],
          ["researcher-ids", "a41c…, 6e0b…, d93f… (memoized)"],
        ],
      },
    },
    {
      title: "Fan out in parallel.",
      body: "Promise.all prompts every researcher at once. Each sees only its own question, so its context stays small, and it runs on a cheaper model.",
      enter: ["r1", "r2", "r3"],
      focus: ["orch", "r1", "r2", "r3"],
      status: {
        orch: "waiting 0/3",
        r1: "researching",
        r2: "researching",
        r3: "researching",
      },
      flows: [
        { edge: "orch-r1", label: "prompt(subtask)" },
        { edge: "orch-r2", label: "prompt(subtask)" },
        { edge: "orch-r3", label: "prompt(subtask)" },
      ],
      panel: {
        kind: "trace",
        title: "orchestrator · job-81",
        spans: [
          {
            name: "ask_specialist",
            depth: 0,
            start: 0,
            width: 100,
            tone: "tool",
          },
          {
            name: "researcher a41c…",
            depth: 1,
            start: 2,
            width: 58,
            note: "SQLite",
            tone: "actor",
          },
          { name: "fetch_page", depth: 2, start: 10, width: 14, tone: "tool" },
          {
            name: "researcher 6e0b…",
            depth: 1,
            start: 2,
            width: 90,
            note: "Postgres",
            tone: "actor",
          },
          { name: "fetch_page", depth: 2, start: 14, width: 20, tone: "tool" },
          {
            name: "researcher d93f…",
            depth: 1,
            start: 2,
            width: 72,
            note: "DuckDB",
            tone: "actor",
          },
        ],
      },
    },
    {
      title: "A crash changes nothing.",
      body: "Kill the server while researchers work and start it again. ask_specialist reruns with the same memoized ids, a finished researcher returns its saved answer, and an unfinished one keeps going.",
      focus: ["orch", "r1", "r2"],
      status: {
        orch: "rerun",
        r1: "saved answer",
        r2: "still working",
        r3: "saved answer",
      },
      flows: [
        { edge: "orch-r1", label: "prompt(same requestId)" },
        { edge: "orch-r2", label: "prompt(same requestId)" },
      ],
      panel: {
        kind: "terminal",
        title: "server",
        lines: [
          { text: "kill -9 <server pid>", tone: "command" },
          { text: "server stopped", tone: "error" },
          { text: "npx tsx server.ts", tone: "command" },
          { text: "ask_specialist rerun · replay: safe", tone: "event" },
          { text: "a41c… returned its saved answer", tone: "ok" },
          {
            text: "6e0b… still working, the rerun waits for it",
            tone: "muted",
          },
        ],
      },
    },
    {
      title: "Merge the answers.",
      body: "Every answer comes back as one tool result and stays in the orchestrator's conversation. The orchestrator combines them into one report.",
      focus: ["orch"],
      status: { orch: "writing report", r1: "done", r2: "done", r3: "done" },
      flows: [
        { edge: "orch-r1", label: "result.text", back: true },
        { edge: "orch-r2", label: "result.text", back: true },
        { edge: "orch-r3", label: "result.text", back: true },
      ],
      panel: {
        kind: "chat",
        title: "orchestrator · job-81",
        messages: [
          { role: "user", text: job },
          {
            role: "tool",
            text: "ask_specialist → ## SQLite at 50M rows… ## Postgres at 50M rows… ## DuckDB at 50M rows…",
          },
          {
            role: "assistant",
            text: "For a read-heavy dashboard at 50 million rows, DuckDB scans fastest. Postgres fits when the same data also takes writes…",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Hand off without waiting.",
      body: "onAnswer sends the finished report to the job's reviewer with requestReview, which saves the request and returns. The orchestrator is done.",
      enter: ["reviewer"],
      focus: ["orch", "reviewer"],
      status: { orch: "done", reviewer: "reviewing" },
      flows: [
        { edge: "orch-reviewer", label: "requestReview(report, requestId)" },
      ],
      panel: {
        kind: "state",
        title: "reviewer · job-81",
        rows: [
          ["requestId", "job-81:1763301234567"],
          ["model", "openai/gpt-5.5, a different family"],
          ["orchestrator waits", "no"],
          ["state.review", "null"],
        ],
      },
    },
    {
      title: "Read the review.",
      body: "The reviewer's onAnswer saves the review in its state. Your app checks getReview every 30 seconds until it is there.",
      focus: ["app", "reviewer"],
      status: { reviewer: "reviewed" },
      flows: [{ edge: "app-reviewer", label: "getReview()" }],
      panel: {
        kind: "terminal",
        title: "client.ts",
        lines: [
          { text: "getReview() → null", tone: "muted" },
          { text: "getReview() → null", tone: "muted" },
          {
            text: "Unsourced: the Postgres index-only scan figure.",
            tone: "event",
          },
          { text: "Gap: no cost comparison for hosting.", tone: "event" },
          { text: "REVISE", tone: "ok" },
        ],
      },
    },
  ],
  code: [
    {
      name: "orchestrator.ts",
      note: "Fan out with memoized ids, then hand the report off from onAnswer.",
      source: `const askSpecialist = defineTool({
  name: "ask_specialist",
  description: "Give each subtask to its own researcher. They work in parallel, and you get every answer back.",
  parameters: obj({
    subtasks: arr(
      str({ description: "One self-contained question. The researcher can't see this conversation." }),
      { minItems: 1, maxItems: 8 },
    ),
  }),
  // A rerun after a crash reaches the same researchers, through the memo below.
  replay: "safe",
  execute: async ({ subtasks }, api, context) => {
    // One id per subtask, saved with this tool call, so a rerun gets the same ids.
    const ids = await api.memo("researcher-ids", subtasks.map(() => crypto.randomUUID()), context);

    const answers = await Promise.all(
      ids.map(async (id, i) => {
        const researcher = client.researcher.getOrCreate([id]);
        // … abort the researcher's run if this run is cancelled
        // A researcher that already answered returns its saved answer for the same requestId.
        const result = await researcher.prompt(subtasks[i], { requestId: id });
        if (result.status === "unanswered") return \`No answer: \${result.reason}\`;
        return result.text || "The researcher finished without an answer.";
      }),
    );

    const text = subtasks.map((subtask, i) => \`## \${subtask}\\n\\n\${answers[i]}\`).join("\\n\\n");
    return { output: [{ type: "text", text }] };
  },
});

// One orchestrator per job, keyed by the job id.
export const orchestrator = pi({
  model: "anthropic/claude-opus-5-5",
  registry: extensions,
  // Hands every finished report to the job's reviewer without waiting for the review.
  onAnswer: async (c, answer) => {
    const [jobId] = c.key;
    if (!answer.text) return;
    // The answer's timestamp is saved with it, so a repeated call sends the same requestId.
    await client.reviewer.getOrCreate([jobId]).requestReview(answer.text, \`\${jobId}:\${answer.message.timestamp}\`);
  },
});`,
    },
    {
      name: "reviewer.ts",
      note: "requestReview saves the report and returns before reviewing it.",
      source: `import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";

const extensions = createRegistry();
extensions.install(
  defineExtension({
    name: "review",
    sections: [
      section(
        "role",
        () =>
          "You review research reports. List claims without a source, gaps, and contradictions, then end with APPROVE or REVISE.",
      ),
    ],
  }),
);

// One reviewer per job, keyed by the job id.
export const reviewer = pi({
  model: "openai/gpt-5.5",
  registry: extensions,
  state: { review: null as string | null },
  // Saves each review so your app can read it.
  onAnswer: (c, answer) => {
    c.state.review = answer.text ?? null;
  },
  actions: {
    // Saves the request and returns without waiting for the review.
    requestReview: async (c, report: string, requestId: string) => {
      const conversation = await c.pi.root(BACKGROUND_CONTEXT);
      await conversation.submit(
        { type: "input", content: \`Review this report:\\n\\n\${report}\`, requestId },
        BACKGROUND_CONTEXT,
      );
    },
    getReview: (c) => c.state.review,
  },
});`,
    },
  ],
};
