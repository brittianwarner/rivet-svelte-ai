import type { ExampleStory } from "../types";

export const sandboxAdapter: ExampleStory = {
  slug: "sandbox-from-any-actor",
  section: "coding-agents",
  title: "Use a Sandbox from Any Actor",
  tagline:
    "Give any Rivet Actor one API to create a sandbox, run commands, use files, and clean up.",
  ideas: [
    "The adapter stores nothing. The actor stores the sandbox id.",
    "create once, connect after every wake, suspend on sleep, destroy on destroy.",
    "Every provider returns the same SandboxProvider, so a swap is one import.",
  ],
  docs: "https://rivet.dev/guides/sandbox-adapter/",
  requires: [
    {
      label: "@rivet-dev/sandbox-adapter",
      detail:
        "SandboxProvider, Sandbox, and the providers. The guide pins no version.",
    },
    {
      label: "rivetkit",
      detail: "actor, event, and setup. This repo pins 3.0.1.",
    },
    {
      label: "docker CLI",
      detail: "On the worker, for dockerProvider. No account needed.",
    },
    {
      label: "Other providers",
      detail:
        "E2B, Daytona, and Freestyle need their SDK and API key. agentOS needs neither.",
    },
  ],
  nodes: [
    { id: "you", label: "Your app", kind: "client", x: 14, y: 30 },
    {
      id: "build",
      label: "build",
      kind: "actor",
      key: '["build-1"]',
      x: 44,
      y: 30,
    },
    {
      id: "state",
      label: "state",
      kind: "store",
      key: "sandboxId",
      x: 44,
      y: 50,
    },
    {
      id: "box",
      label: "Docker container",
      kind: "sandbox",
      key: "ubuntu:24.04",
      x: 76,
      y: 18,
    },
    {
      id: "other",
      label: "Any provider",
      kind: "sandbox",
      key: "agentOS · E2B · Daytona",
      x: 76,
      y: 44,
    },
  ],
  edges: [
    { id: "you-build", from: "you", to: "build" },
    { id: "build-state", from: "build", to: "state", dashed: true },
    { id: "build-box", from: "build", to: "box" },
    { id: "build-other", from: "build", to: "other", dashed: true },
  ],
  beats: [
    {
      title: "Any actor can own a sandbox.",
      body: "The build actor runs its own process, such as a build or a coding CLI. It starts with no sandbox, only a place to store one id.",
      enter: ["you", "build", "state"],
      focus: ["build"],
      status: { build: "no sandbox" },
      flows: [{ edge: "you-build", label: "saveFile(path, content)" }],
      panel: {
        kind: "state",
        title: "build state",
        rows: [
          ["sandboxId", "null"],
          ["provider", 'dockerProvider({ image: "ubuntu:24.04" })'],
          ["shared by", "every build actor"],
        ],
      },
    },
    {
      title: "The first call creates it.",
      body: "No id is stored, so openSandbox calls create and stores the new id right away. Then connect returns a Sandbox to use.",
      enter: ["box"],
      focus: ["build", "box", "state"],
      status: { build: "opening", box: "created" },
      flows: [
        { edge: "build-box", label: "provider.create(c)" },
        { edge: "build-state", label: "save sandboxId" },
      ],
      panel: {
        kind: "state",
        title: "lifecycle calls",
        rows: [
          ["create(c)", "no id stored → new id, store it"],
          ["connect(c, id)", "after a wake → Sandbox or undefined"],
          ["suspend?.(c, id)", "in onSleep"],
          ["destroy?.(c, id)", "in onDestroy"],
        ],
      },
    },
    {
      title: "Write a file.",
      body: "saveFile resolves the path inside the sandbox, creates the parent directory, and writes the string. All paths are absolute inside the sandbox.",
      focus: ["build", "box"],
      status: { build: "saving", box: "writing" },
      flows: [{ edge: "build-box", label: "writeFile(target, content)" }],
      panel: {
        kind: "state",
        title: "file operations",
        rows: [
          ["readFile(path)", "Uint8Array"],
          ["writeFile(path, content)", "strings only; parent must exist"],
          ["mkdir(path)", "creates the directory"],
          ["stat · readdir · exists", "isDirectory · names · boolean"],
        ],
      },
    },
    {
      title: "Run a command and stream it.",
      body: "run calls exec, which runs one command and waits for it to end. onData gets stdout and stderr as they arrive, and the actor broadcasts each chunk as output. A non-zero exit is a result, not an error.",
      focus: ["you", "build", "box"],
      status: { build: "running", box: "exec" },
      flows: [
        { edge: "build-box", label: "exec(command)" },
        { edge: "you-build", label: "output", back: true },
      ],
      panel: {
        kind: "terminal",
        title: "output events",
        lines: [
          { text: "sh build.sh", tone: "command" },
          { text: "compiling 12 files", tone: "event" },
          { text: "done in 3.1s", tone: "event" },
          {
            text: "{ exitCode: 0, timedOut: false, stdout, stderr }",
            tone: "ok",
          },
        ],
      },
    },
    {
      title: "Sleep stops the container.",
      body: "onSleep calls suspend, so the sandbox uses no resources while the actor sleeps. The Sandbox object lived only in memory. The id is what survives.",
      focus: ["build", "box"],
      status: { build: "asleep", box: "stopped" },
      flows: [{ edge: "build-box", label: "provider.suspend()" }],
      panel: {
        kind: "state",
        title: "while asleep",
        rows: [
          ["sandboxId", "saved in state"],
          ["Sandbox object", "gone; connect again after a wake"],
          ["container", "stopped, files kept"],
        ],
      },
    },
    {
      title: "Wake and connect.",
      body: "The next call connects with the stored id. undefined means the sandbox is gone, so a new empty one is created. A thrown error keeps the id, so an outage never replaces the sandbox.",
      focus: ["build", "box", "state"],
      status: { build: "awake", box: "started" },
      flows: [
        { edge: "you-build", label: "readFile(path)" },
        { edge: "build-box", label: "provider.connect(c, id)" },
      ],
      panel: {
        kind: "state",
        title: "connect(c, id) returns",
        rows: [
          ["a Sandbox", "same sandbox, same files"],
          ["undefined", "gone: create a new one, files lost"],
          ["throws", "keep the id and retry later"],
        ],
      },
    },
    {
      title: "Swap one import.",
      body: "Every provider returns the same SandboxProvider. Change the import and the call, and the actor code stays the same.",
      enter: ["other"],
      focus: ["other"],
      status: { other: "same interface" },
      flows: [{ edge: "build-other", label: "SandboxProvider" }],
      panel: {
        kind: "state",
        title: "provider · credentials",
        rows: [
          ["agentOSProvider()", "none"],
          ["e2bProvider()", "E2B_API_KEY"],
          ["daytonaProvider()", "DAYTONA_API_KEY"],
          ["freestyleProvider({ create })", "FREESTYLE_API_KEY"],
          ["dockerProvider()", "none"],
        ],
      },
    },
    {
      title: "Destroy cleans up.",
      body: "onDestroy calls destroy and the sandbox is deleted. agentOS has no suspend or destroy, so its VM sleeps on its own and stays after the actor is gone.",
      exit: ["other"],
      focus: ["build", "box"],
      status: { build: "destroyed", box: "removed" },
      flows: [{ edge: "build-box", label: "provider.destroy()" }],
      panel: {
        kind: "state",
        title: "after destroy",
        rows: [
          ["build actor", "destroyed"],
          ["Docker container", "removed"],
          ["agentOS VM (if used)", "left in place"],
        ],
      },
    },
  ],
  code: [
    {
      name: "server.ts",
      note: "The actor stores the id and decides when to create, connect, suspend, and destroy.",
      source: `// One provider object serves every Actor of this definition.
const provider = dockerProvider({ image: "ubuntu:24.04" });

export const build = actor({
  state: { sandboxId: null } as BuildState,
  events: {
    // Command output, as it arrives.
    output: event<string>(),
  },
  actions: {
    run: async (c, command: string) => {
      const sandbox = await openSandbox(c, c.state);
      const decoder = new TextDecoder();
      return sandbox.exec(command, {
        cwd: sandbox.cwd,
        timeoutMs: 60_000,
        // Stops the command if the Actor shuts down.
        signal: c.abortSignal,
        onData: (chunk) => c.broadcast("output", decoder.decode(chunk, { stream: true })),
      });
    },
    // … saveFile and readFile
  },
  // The sandbox stops while the Actor sleeps and is removed along with the Actor.
  onSleep: async (c) => {
    if (c.state.sandboxId) await provider.suspend?.(c, c.state.sandboxId);
  },
  onDestroy: async (c) => {
    if (c.state.sandboxId) await provider.destroy?.(c, c.state.sandboxId);
  },
});

// Connects to this Actor's sandbox. The first call creates it.
async function openSandbox(c: SandboxActorContext, state: BuildState): Promise<Sandbox> {
  const existing = state.sandboxId ? await provider.connect(c, state.sandboxId) : undefined;
  if (existing) return existing;
  state.sandboxId = await provider.create(c);
  const sandbox = await provider.connect(c, state.sandboxId);
  if (!sandbox) throw new Error(\`Sandbox \${state.sandboxId} was not found right after it was created.\`);
  return sandbox;
}`,
    },
    {
      name: "provider.ts",
      note: "Your own SandboxProvider: a name, create, connect, and optional suspend and destroy.",
      source: `export function vmProvider(vms: VmClient): SandboxProvider {
  const cwd = "/workspace";
  return {
    name: "my-vms",
    cwd,
    create: () => vms.create(),
    connect: async (_c, id) => {
      if (!(await vms.start(id))) return undefined;
      await vms.mkdir(id, cwd);
      return vmSandbox(vms, id, cwd);
    },
    suspend: (_c, id) => vms.stop(id),
    destroy: (_c, id) => vms.delete(id),
  };
}

function vmSandbox(vms: VmClient, id: string, cwd: string): Sandbox {
  return {
    cwd,
    exec: async (command, options) =>
      // Streams output and applies the timeout and abort signal.
      runRemoteProcess(await vms.spawn(id, command, { cwd: options.cwd, env: options.env }), options),
    readFile: (path) => vms.readFile(id, path),
    // … writeFile, mkdir, stat, readdir, exists
  };
}`,
    },
  ],
};
