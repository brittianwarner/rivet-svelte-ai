import type { ChatLine, ExampleStory } from "../types";

const context: ChatLine[] = [
  {
    role: "user",
    text: "We need 10,000 aluminum enclosures per month. Lead time matters more than price.",
  },
  {
    role: "assistant",
    text: "Understood. I will weigh lead time first, then price and supply risk.",
  },
];
const ghost = context.map((line) => ({ ...line, ghost: true }));

export const forkingSubagents: ExampleStory = {
  slug: "forking-subagents",
  section: "agents",
  title: "Forking Subagents",
  tagline:
    "Split independent work across subagents that already know the whole conversation.",
  ideas: [
    "The parent forks itself once per subtask, so no subagent needs the context restated.",
    "Each subagent gets its task as fork input and reports to fork.actorId, which comes from Rivet.",
    "Subagents report and destroy themselves. The last report makes the parent combine them.",
  ],
  docs: "https://rivet.dev/guides/forking-subagents/",
  requires: [
    {
      label: "rivetkit 3.1+",
      detail: "fork() and onFork arrive in 3.1. This repo targets 3.1.1.",
    },
    {
      label: "@rivet-dev/pi",
      detail:
        "With @earendil-works/pi-durable, pi-ai, and chord. One agent plays parent and subagent.",
    },
    { label: "zod", detail: "Validates the task that arrives as fork input." },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "Every copy runs on anthropic/claude-opus-5-5.",
    },
    {
      label: "No sandbox",
      detail: "A forked subagent would run its tools in the parent's sandbox.",
    },
  ],
  nodes: [
    { id: "you", label: "You", kind: "client", x: 14, y: 30 },
    {
      id: "parent",
      label: "agent",
      kind: "agent",
      key: "sourcing",
      x: 44,
      y: 30,
    },
    {
      id: "a",
      label: "subagent",
      kind: "fork",
      key: "Supplier A",
      x: 78,
      y: 11,
    },
    {
      id: "b",
      label: "subagent",
      kind: "fork",
      key: "Supplier B",
      x: 78,
      y: 30,
    },
    {
      id: "c",
      label: "subagent",
      kind: "fork",
      key: "Supplier C",
      x: 78,
      y: 49,
    },
  ],
  edges: [
    { id: "you-parent", from: "you", to: "parent" },
    { id: "parent-a", from: "parent", to: "a" },
    { id: "parent-b", from: "parent", to: "b" },
    { id: "parent-c", from: "parent", to: "c" },
  ],
  beats: [
    {
      title: "Give the parent context.",
      body: "You prompt the parent agent with the request, then connect and listen for its answer event. This conversation is what every subagent will start with.",
      enter: ["you", "parent"],
      focus: ["you", "parent"],
      status: { parent: "answering" },
      flows: [{ edge: "you-parent", label: "prompt(text, { requestId })" }],
      panel: { kind: "chat", title: "agent · sourcing", messages: context },
    },
    {
      title: "Wait for idle, then fork.",
      body: "research waits for the parent to go idle, so no turn in progress is copied. It then forks the parent once per supplier, with the task as fork input.",
      enter: ["a", "b", "c"],
      focus: ["parent", "a", "b", "c"],
      status: { parent: "waiting 0/3", a: "forked", b: "forked", c: "forked" },
      flows: [
        { edge: "you-parent", label: "research([A, B, C])" },
        { edge: "parent-a", label: "fork({ input })" },
        { edge: "parent-b", label: "fork({ input })" },
        { edge: "parent-c", label: "fork({ input })" },
      ],
      panel: {
        kind: "state",
        title: "agent · sourcing · state",
        rows: [
          ["waiting", "Supplier A, Supplier B, Supplier C"],
          ["reports", "{}"],
          ["research returns", "once every subagent exists"],
        ],
      },
    },
    {
      title: "onFork records the task.",
      body: "Each fork validates its input and takes its parent's id from fork.actorId, not from the input. The copied waiting list and reports are reset.",
      focus: ["a"],
      status: { a: "onFork", b: "onFork", c: "onFork" },
      panel: {
        kind: "state",
        title: "subagent · Supplier A · state",
        rows: [
          ["task.name", "Supplier A"],
          ["task.parentId", "fork.actorId (from Rivet)"],
          ["waiting", "[] (reset)"],
          ["reports", "{} (reset)"],
        ],
      },
    },
    {
      title: "Each subagent works its task.",
      body: 'onWake submits the instructions with requestId "subtask", so a later wake does not queue them twice. The subagent already knows the request.',
      focus: ["a", "b", "c"],
      status: { a: "researching", b: "researching", c: "researching" },
      panel: {
        kind: "chat",
        title: "subagent · Supplier A",
        messages: [
          ...ghost,
          {
            role: "user",
            text: "Research the supplier Supplier A for the request above: pricing, lead times and risks. Answer in one paragraph.",
          },
          {
            role: "assistant",
            text: "Supplier A quotes 6-week lead times at 10,000 units and…",
            streaming: true,
          },
        ],
      },
    },
    {
      title: "Report up and go away.",
      body: "onAnswer schedules finishTask, which calls report on the parent and then destroys the subagent. The parent stores the report and keeps waiting.",
      exit: ["a"],
      focus: ["parent", "a"],
      status: { parent: "1 of 3", b: "researching", c: "researching" },
      flows: [{ edge: "parent-a", label: "report(name, text)", back: true }],
      panel: {
        kind: "state",
        title: "agent · sourcing · state",
        rows: [
          ["reports.Supplier A", "6-week lead time, stable pricing…"],
          ["reports.Supplier B", "waiting"],
          ["reports.Supplier C", "waiting"],
        ],
      },
    },
    {
      title: "The last report combines.",
      body: "When every subagent has reported, the parent submits one message with all the reports. Its requestId turns a second, concurrent last report into a no-op.",
      exit: ["b", "c"],
      focus: ["parent"],
      status: { parent: "combining" },
      flows: [
        { edge: "parent-b", label: "report(name, text)", back: true },
        { edge: "parent-c", label: "report(name, text)", back: true },
      ],
      panel: {
        kind: "state",
        title: "agent · sourcing",
        rows: [
          ["reports", "3 of 3"],
          ["requestId", "combine:Supplier A,Supplier B,Supplier C"],
          ["subagents alive", "0"],
        ],
      },
    },
    {
      title: "Stream the recommendation.",
      body: "The parent has no task, so its onAnswer broadcasts the answer event. The client prints the combined recommendation.",
      focus: ["you", "parent"],
      status: { parent: "done" },
      flows: [{ edge: "you-parent", label: "answer", back: true }],
      panel: {
        kind: "chat",
        title: "agent · sourcing",
        messages: [
          ...context,
          {
            role: "system",
            text: "Your subagents reported: Supplier A… Supplier B… Supplier C…",
          },
          {
            role: "assistant",
            text: "Go with Supplier A. It has the shortest lead time at your volume. Keep Supplier C as a second source…",
            streaming: true,
          },
        ],
      },
    },
  ],
  code: [
    {
      name: "server.ts (hooks)",
      note: "onFork records the task, onWake queues it, onAnswer reports or streams.",
      source: `export const agent = pi({
  model: "anthropic/claude-opus-5-5",
  registry: createRegistry(),
  state: {
    // On a subagent: its task and the parent to report to.
    task: null as null | { name: string; instructions: string; parentId: string },
    // On a parent: the subtasks it waits for, and their reports.
    waiting: [] as string[],
    reports: {} as Record<string, string>,
  },
  events: { answer: event<string>() },

  // Runs once, at the first start of a fork. fork.actorId is the parent: it
  // comes from Rivet, not from the input.
  onFork: (c, fork) => {
    const task = TaskInput.safeParse(fork.input);
    c.state.task = task.success ? { ...task.data, parentId: fork.actorId } : null;
    c.state.waiting = [];
    c.state.reports = {};
  },

  // Pi runs the app's onWake before it resumes work. A subagent queues its
  // task here; the request id keeps a later wake from queueing it twice.
  onWake: async (c) => {
    if (!c.state.task) return;
    const conversation = await c.pi.root(BACKGROUND_CONTEXT);
    await conversation.submit(
      { type: "input", content: c.state.task.instructions, requestId: "subtask" },
      BACKGROUND_CONTEXT,
    );
  },

  // A subagent reports its answer and goes away. A parent streams its answers.
  onAnswer: async (c, answer) => {
    if (c.state.task) {
      await c.schedule.after(0, "finishTask", answer.text ?? "");
    } else {
      c.broadcast("answer", answer.text ?? "");
    }
  },
  // … actions
});`,
    },
    {
      name: "server.ts (actions)",
      note: "Fork per supplier, report and destroy, combine on the last report.",
      source: `actions: {
  // Parent: fork one subagent per supplier. Each starts with this conversation.
  research: async (c, suppliers: string[]): Promise<void> => {
    // A turn in progress would be copied into every subagent, so wait for it.
    await c.pi.waitForIdle(BACKGROUND_CONTEXT);
    c.state.waiting = suppliers;
    c.state.reports = {};
    const client = c.client<typeof registry>();
    await Promise.all(
      suppliers.map((name) =>
        client.agent.fork(c.actorId, {
          input: { name, instructions: \`Research the supplier \${name} for the request above: pricing, lead times and risks. Answer in one paragraph.\` },
        }),
      ),
    );
  },

  // Subagent: send the report to the parent, then destroy this subagent.
  finishTask: async (c, report: string): Promise<void> => {
    const task = c.state.task;
    if (!task) return;
    await c.client<typeof registry>().agent.getForId(task.parentId).report(task.name, report);
    c.destroy();
  },

  // Parent: store a report, and combine them once every subagent reported.
  report: async (c, name: string, report: string): Promise<void> => {
    if (!c.state.waiting.includes(name)) return;
    c.state.reports[name] = report;
    if (!c.state.waiting.every((waited) => waited in c.state.reports)) return;
    const reports = c.state.waiting.map((waited) => \`\${waited}: \${c.state.reports[waited]}\`).join("\\n\\n");
    const conversation = await c.pi.root(BACKGROUND_CONTEXT);
    // The request id makes a second, concurrent last report a no-op.
    await conversation.submit(
      {
        type: "input",
        content: \`Your subagents reported:\\n\\n\${reports}\\n\\nCombine them into one recommendation.\`,
        requestId: \`combine:\${c.state.waiting.join(",")}\`,
      },
      BACKGROUND_CONTEXT,
    );
  },
},`,
    },
  ],
};
