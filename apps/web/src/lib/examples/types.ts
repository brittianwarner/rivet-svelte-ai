/**
 * Example stories are data. One renderer draws every example, so each new
 * example is a file of nodes, edges, and beats — not a new component.
 *
 * Coordinates use a 100 × 60 stage. Nodes are placed by their center.
 */

export type Section = "foundations" | "agents" | "coding-agents";

export type NodeKind =
  | "client" // a browser, phone, or script
  | "actor" // a plain Rivet Actor
  | "agent" // an actor that runs a model loop
  | "fork" // a copy-on-write fork of an agent
  | "sandbox" // a VM or container the actor drives
  | "service" // something outside Rivet: Twilio, OpenAI, a collector
  | "store"; // SQLite, KV, or object storage inside an actor

export interface StoryNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** The actor key, shown in mono under the label. */
  key?: string;
  x: number;
  y: number;
}

export interface StoryEdge {
  id: string;
  from: string;
  to: string;
  /** Dashed edges are relationships, not calls: "forked from", "stores in". */
  dashed?: boolean;
}

/** A message traveling along an edge during one beat. */
export interface Flow {
  edge: string;
  label: string;
  /** Travel from `to` back to `from`. */
  back?: boolean;
}

export type Panel =
  | { kind: "chat"; title: string; messages: ChatLine[] }
  | { kind: "terminal"; title: string; lines: TerminalLine[] }
  | { kind: "phone"; title: string; messages: ChatLine[] }
  | { kind: "trace"; title: string; spans: TraceSpan[] }
  | { kind: "state"; title: string; rows: [string, string][] };

export interface ChatLine {
  role: "user" | "assistant" | "system" | "tool";
  text: string;
  /** Rendered faded: copied history, a discarded fork, a superseded draft. */
  ghost?: boolean;
  /** Rendered with a live cursor. */
  streaming?: boolean;
}

export interface TerminalLine {
  text: string;
  tone?: "command" | "event" | "ok" | "error" | "muted";
}

export interface TraceSpan {
  name: string;
  depth: number;
  /** Start and width as percentages of the trace. */
  start: number;
  width: number;
  note?: string;
  tone?: "model" | "tool" | "actor" | "error";
}

export interface Beat {
  title: string;
  body: string;
  /** Nodes that appear from this beat on. Earlier nodes stay. */
  enter?: string[];
  /** Nodes that leave from this beat on (a destroyed fork). */
  exit?: string[];
  /** Nodes to emphasize. Everything else dims slightly. */
  focus?: string[];
  /** Status badges by node id. Replaces the previous beat's badges. */
  status?: Record<string, string>;
  flows?: Flow[];
  panel?: Panel;
}

export interface CodeFile {
  name: string;
  source: string;
  /** One-line reason this file matters. */
  note: string;
}

export interface Requirement {
  label: string;
  detail: string;
}

export interface ExampleStory {
  slug: string;
  section: Section;
  title: string;
  /** One sentence: the problem this solves. */
  tagline: string;
  /** Short list of the ideas a reader leaves with. */
  ideas: string[];
  docs: string;
  /** Packages, keys, and services needed to run it for real. */
  requires: Requirement[];
  /** Live demo route inside this app, when one exists. */
  live?: string;
  nodes: StoryNode[];
  edges: StoryEdge[];
  beats: Beat[];
  code: CodeFile[];
}
