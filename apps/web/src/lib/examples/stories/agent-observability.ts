import type { ExampleStory, TraceSpan } from "../types";

// One prompt with one tool call, laid out as the run's trace in the docs.
const submit: TraceSpan = {
  name: "pi.durable.submit",
  depth: 0,
  start: 0,
  width: 100,
  tone: "actor",
  note: "linked to agent/prompt",
};
const prepare: TraceSpan = {
  name: "pi.durable.phase",
  depth: 1,
  start: 1,
  width: 5,
  tone: "actor",
  note: "pi.generation prepare",
};
const request: TraceSpan = {
  name: "pi.durable.phase",
  depth: 1,
  start: 6,
  width: 48,
  tone: "actor",
  note: "pi.generation request",
};
const chat: TraceSpan = {
  name: "chat claude-opus-5-5",
  depth: 2,
  start: 7,
  width: 24,
  tone: "model",
  note: "1,840 in · 96 out · $0.011",
};
const toolCall: TraceSpan = {
  name: "pi.durable.phase",
  depth: 2,
  start: 32,
  width: 21,
  tone: "tool",
  note: "pi.tool call · lookup",
};
const lookup: TraceSpan = {
  name: "app.lookup",
  depth: 3,
  start: 34,
  width: 17,
  tone: "tool",
  note: "your span",
};
const tools: TraceSpan = {
  name: "pi.durable.phase",
  depth: 1,
  start: 55,
  width: 44,
  tone: "actor",
  note: "pi.generation tools",
};
const prepare2: TraceSpan = {
  name: "pi.durable.phase",
  depth: 2,
  start: 56,
  width: 4,
  tone: "actor",
  note: "pi.generation prepare",
};
const request2: TraceSpan = {
  name: "pi.durable.phase",
  depth: 2,
  start: 60,
  width: 38,
  tone: "actor",
  note: "pi.generation request",
};
const chat2: TraceSpan = {
  name: "chat claude-opus-5-5",
  depth: 3,
  start: 61,
  width: 36,
  tone: "model",
  note: "2,010 in · 142 out · $0.014",
};

export const agentObservability: ExampleStory = {
  slug: "trace-agent-runs",
  section: "agents",
  title: "Trace Agent Runs",
  tagline:
    "See every step of an agent run, with model tokens and cost, in the tracing tool you already use.",
  ideas: [
    "A prompt makes two linked traces: the caller's, and the run's own.",
    "A run keeps its trace ID across retries, sleeps, and restarts.",
    "Traces never record prompt text, tool arguments, tool results, or error messages.",
  ],
  docs: "https://rivet.dev/guides/agent-observability/",
  requires: [
    {
      label: "@rivet-dev/pi + @earendil-works/pi-durable",
      detail: "Pi traces each run on its own. No pi() option to set.",
    },
    {
      label: "@opentelemetry/api + @opentelemetry/sdk-node",
      detail:
        "Start NodeSDK before the registry. Without it, only RivetKit's spans export.",
    },
    {
      label: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      detail:
        "Setting it turns tracing on. Add OTEL_SERVICE_NAME and the protocol.",
    },
    {
      label: "An OTLP collector",
      detail: "Any tracing backend that accepts OTLP over HTTP or gRPC.",
    },
  ],
  nodes: [
    {
      id: "caller",
      label: "your app",
      kind: "client",
      key: "client.ts",
      x: 14,
      y: 30,
    },
    { id: "agent", label: "agent", kind: "agent", key: "demo", x: 46, y: 30 },
    {
      id: "model",
      label: "model",
      kind: "service",
      key: "claude-opus-5-5",
      x: 82,
      y: 13,
    },
    {
      id: "collector",
      label: "collector",
      kind: "service",
      key: ":4318/v1/traces",
      x: 82,
      y: 47,
    },
    {
      id: "tasks",
      label: "tasks",
      kind: "store",
      key: "trace context",
      x: 46,
      y: 50,
    },
  ],
  edges: [
    { id: "caller-agent", from: "caller", to: "agent" },
    { id: "agent-model", from: "agent", to: "model" },
    { id: "agent-collector", from: "agent", to: "collector" },
    { id: "agent-tasks", from: "agent", to: "tasks", dashed: true },
  ],
  beats: [
    {
      title: "Turn on export.",
      body: "The OTLP endpoint variable exports RivetKit's own spans. Pi's spans use @opentelemetry/api in your process, so they also need NodeSDK started before the registry.",
      enter: ["agent", "collector"],
      focus: ["agent", "collector"],
      status: { collector: "listening" },
      flows: [{ edge: "agent-collector", label: "OTLP" }],
      panel: {
        kind: "terminal",
        title: "worker",
        lines: [
          { text: "OTEL_SERVICE_NAME=my-rad-app", tone: "command" },
          {
            text: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces",
            tone: "command",
          },
          {
            text: "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf",
            tone: "command",
          },
          {
            text: "new NodeSDK().start()  // before the registry",
            tone: "event",
          },
          { text: "RivetKit spans: on   Pi spans: on", tone: "ok" },
        ],
      },
    },
    {
      title: "A prompt starts the caller's trace.",
      body: "The prompt action gets an agent/prompt span. Under it, invoke_agent pi lasts from saving the input until the run settles.",
      enter: ["caller"],
      focus: ["caller", "agent"],
      status: { agent: "prompted" },
      flows: [{ edge: "caller-agent", label: "prompt()" }],
      panel: {
        kind: "trace",
        title: "caller's trace",
        spans: [
          {
            name: "agent/prompt",
            depth: 0,
            start: 0,
            width: 100,
            tone: "actor",
            note: "RivetKit",
          },
          {
            name: "invoke_agent pi",
            depth: 1,
            start: 2,
            width: 96,
            tone: "actor",
            note: "until the run settles",
          },
        ],
      },
    },
    {
      title: "The run gets its own trace.",
      body: "The run is a second trace, linked to the caller's. Pi saves the trace context with its tasks, and each step of a task is a pi.durable.phase span.",
      enter: ["tasks"],
      focus: ["agent", "tasks"],
      status: { agent: "preparing" },
      flows: [{ edge: "agent-tasks", label: "save task" }],
      panel: {
        kind: "trace",
        title: "run trace 4bf92f35",
        spans: [submit, prepare],
      },
    },
    {
      title: "The model call carries usage.",
      body: "Each model call is a chat span with the model, input and output tokens, and cost in USD. Every retry is its own span.",
      enter: ["model"],
      focus: ["agent", "model"],
      status: { agent: "calling model" },
      flows: [{ edge: "agent-model", label: "chat claude-opus-5-5" }],
      panel: {
        kind: "trace",
        title: "run trace 4bf92f35",
        spans: [submit, prepare, request, chat],
      },
    },
    {
      title: "Your span nests under the tool.",
      body: "The model asks for a tool. The tool's phase gets a span, and a span you start inside the tool with @opentelemetry/api appears under it.",
      focus: ["agent"],
      status: { agent: "running tool" },
      panel: {
        kind: "trace",
        title: "run trace 4bf92f35",
        spans: [submit, prepare, request, chat, toolCall, lookup],
      },
    },
    {
      title: "A restart keeps the trace.",
      body: "The worker restarts before the next model call. The run continues from its last saved step and reads the trace context back, so its new spans join the same trace ID.",
      focus: ["agent", "tasks"],
      status: { agent: "restarted" },
      flows: [{ edge: "agent-tasks", label: "trace context", back: true }],
      panel: {
        kind: "trace",
        title: "run trace 4bf92f35 (same ID)",
        spans: [
          submit,
          prepare,
          request,
          chat,
          toolCall,
          lookup,
          { ...tools, note: "pi.generation tools · resumed" },
        ],
      },
    },
    {
      title: "The run settles.",
      body: "A second model call writes the answer. The spans export in the background, so a slow collector never holds up the run.",
      focus: ["model", "collector"],
      status: { agent: "done" },
      flows: [
        { edge: "agent-model", label: "chat claude-opus-5-5" },
        { edge: "agent-collector", label: "export spans" },
      ],
      panel: {
        kind: "trace",
        title: "run trace 4bf92f35",
        spans: [
          submit,
          prepare,
          request,
          chat,
          toolCall,
          lookup,
          tools,
          prepare2,
          request2,
          chat2,
        ],
      },
    },
    {
      title: "Prompt text is never recorded.",
      body: "Spans carry names, timings, models, tokens, and the type of any failure. The words stay in the conversation, where you read them with the client.",
      focus: ["collector"],
      status: { collector: "no prompt text" },
      panel: {
        kind: "state",
        title: "what a trace holds",
        rows: [
          ["recorded", "span names, durations, model, tokens, cost"],
          ["on failure", "error.type only, such as provider_error"],
          ["never", "prompt text, tool arguments, tool results"],
          ["never", "error messages"],
          ["Pi's own storage", "no spans"],
        ],
      },
    },
  ],
  code: [
    {
      name: ".env",
      note: "Setting the endpoint turns tracing on for RivetKit's spans.",
      source: `OTEL_SERVICE_NAME=my-rad-app
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`,
    },
    {
      name: "sdk.ts",
      note: "Start the SDK before your registry, so Pi's spans export too.",
      source: `import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK();
sdk.start();`,
    },
    {
      name: "application-span.ts",
      note: "Your own span. In a tool, the same call nests it under the tool's phase.",
      source: `import { SpanStatusCode, trace } from "@opentelemetry/api";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";

const tracer = trace.getTracer("counter");

export const counter = actor({
  db: db(),
  actions: {
    query: async (c) =>
      tracer.startActiveSpan("counter.query", async (span) => {
        try {
          return await c.db.execute("SELECT 1 AS value");
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      }),
  },
});`,
    },
  ],
};
