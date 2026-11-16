import type { ChatLine, ExampleStory } from "../types";

const question: ChatLine = {
  role: "user",
  text: "What's the weather in Tokyo?",
};

export const personalAgent: ExampleStory = {
  slug: "personal-agent-sms",
  section: "agents",
  title: "Personal Agent over SMS",
  tagline:
    "Answer texts with a personal agent without holding Twilio's webhook open while the model works.",
  ideas: [
    "One user Actor and one assistant agent per phone number, keyed by the number.",
    "The webhook hands the text off with submit and returns at once. onAnswer texts the reply later.",
    "The Twilio message id is the requestId, so a duplicate delivery runs the agent once.",
  ],
  docs: "https://rivet.dev/guides/personal-agent/",
  requires: [
    {
      label: "@rivet-dev/pi",
      detail:
        "With @earendil-works/pi-durable, pi-ai, and pi-schema for the agent loop, tools, and schemas.",
    },
    {
      label: "rivetkit",
      detail: "Actors, the registry, and the client. This repo targets 3.1.1.",
    },
    {
      label: "hono + @hono/node-server",
      detail: "The HTTP server that hosts /sms/webhook.",
    },
    {
      label: "Twilio account",
      detail:
        "An SMS-capable number and a Verify service. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, TWILIO_VERIFY_SERVICE_SID, and TWILIO_WEBHOOK_URL.",
    },
    {
      label: "Public URL",
      detail: "Twilio must reach the webhook. Use ngrok when testing locally.",
    },
    {
      label: "ANTHROPIC_API_KEY",
      detail: "The assistant runs on anthropic/claude-opus-5-5.",
    },
  ],
  nodes: [
    {
      id: "phone",
      label: "Your phone",
      kind: "client",
      key: "+15551234567",
      x: 14,
      y: 30,
    },
    {
      id: "twilio",
      label: "Twilio",
      kind: "service",
      key: "SMS + Verify",
      x: 40,
      y: 12,
    },
    {
      id: "server",
      label: "HTTP server",
      kind: "service",
      key: "/sms/webhook",
      x: 70,
      y: 12,
    },
    {
      id: "user",
      label: "user",
      kind: "actor",
      key: "+15551234567",
      x: 40,
      y: 48,
    },
    {
      id: "assistant",
      label: "assistant",
      kind: "agent",
      key: "+15551234567",
      x: 74,
      y: 40,
    },
  ],
  edges: [
    { id: "phone-user", from: "phone", to: "user" },
    { id: "phone-twilio", from: "phone", to: "twilio" },
    { id: "twilio-server", from: "twilio", to: "server" },
    { id: "server-user", from: "server", to: "user" },
    { id: "server-assistant", from: "server", to: "assistant" },
    { id: "assistant-twilio", from: "assistant", to: "twilio" },
  ],
  beats: [
    {
      title: "Sign in by text.",
      body: "The sign-in page calls sendCode on the user Actor keyed by your number, and Twilio Verify texts a code. verify checks it and saves the sign-in in the Actor's SQLite database.",
      enter: ["phone", "twilio", "user"],
      focus: ["phone", "user"],
      status: { user: "verified" },
      flows: [{ edge: "phone-user", label: "verify(code)" }],
      panel: {
        kind: "phone",
        title: "Messages · Twilio Verify",
        messages: [
          { role: "assistant", text: "Your verification code is 482913." },
          {
            role: "system",
            text: "Signed in. Text the assistant's number to start.",
          },
        ],
      },
    },
    {
      title: "You send a text.",
      body: "Twilio posts the text to /sms/webhook with the sender's number and a message id. Twilio waits at most 15 seconds for a response.",
      enter: ["server"],
      focus: ["twilio", "server"],
      status: { twilio: "15 s limit" },
      flows: [
        { edge: "phone-twilio", label: "SMS" },
        { edge: "twilio-server", label: "POST /sms/webhook" },
      ],
      panel: {
        kind: "terminal",
        title: "server.ts",
        lines: [
          { text: "POST /sms/webhook", tone: "command" },
          { text: "From=+15551234567", tone: "muted" },
          { text: "Body=What's the weather in Tokyo?", tone: "muted" },
          { text: "MessageSid=SM7f3a9c…", tone: "muted" },
          { text: "x-twilio-signature verified", tone: "ok" },
        ],
      },
    },
    {
      title: "Check the sender.",
      body: "The server asks the sender's user Actor whether the number signed in. A number that has not gets a reply telling it to sign in.",
      focus: ["server", "user"],
      status: { user: "signed in" },
      flows: [{ edge: "server-user", label: "isSignedIn()" }],
      panel: {
        kind: "state",
        title: "user · +15551234567",
        rows: [
          ["profile.verified_at", "saved at sign-in"],
          ["isSignedIn()", "true"],
          ["stores the code", "no, Twilio Verify does"],
        ],
      },
    },
    {
      title: "Hand off and return.",
      body: "submit hands the text to the sender's assistant and returns without waiting for the answer. The server answers Twilio with empty TwiML, well inside the 15-second limit.",
      enter: ["assistant"],
      focus: ["server", "assistant"],
      status: { server: "returned", assistant: "queued" },
      flows: [
        { edge: "server-assistant", label: "submit(Body, { requestId })" },
      ],
      panel: {
        kind: "terminal",
        title: "server.ts",
        lines: [
          { text: 'assistant.getOrCreate(["+15551234567"])', tone: "command" },
          {
            text: '.submit(Body, { requestId: "SM7f3a9c…" })',
            tone: "command",
          },
          { text: "submitted, not waiting for the answer", tone: "event" },
          { text: "200 <Response></Response>", tone: "ok" },
          {
            text: "Twilio sends nothing for an empty response.",
            tone: "muted",
          },
        ],
      },
    },
    {
      title: "The agent answers on its own.",
      body: "The first text created this assistant, and every later text reaches the same one with the whole conversation. It calls get_weather and writes a short plain-text answer.",
      focus: ["assistant"],
      status: { assistant: "get_weather" },
      panel: {
        kind: "trace",
        title: "assistant · +15551234567",
        spans: [
          {
            name: "POST /sms/webhook",
            depth: 0,
            start: 0,
            width: 6,
            note: "returned",
            tone: "actor",
          },
          {
            name: "assistant run",
            depth: 0,
            start: 4,
            width: 94,
            tone: "actor",
          },
          { name: "model", depth: 1, start: 5, width: 26, tone: "model" },
          {
            name: "get_weather",
            depth: 1,
            start: 32,
            width: 10,
            note: "replay: safe",
            tone: "tool",
          },
          { name: "model", depth: 1, start: 43, width: 38, tone: "model" },
          {
            name: "onAnswer",
            depth: 1,
            start: 82,
            width: 16,
            note: "sendSms",
            tone: "actor",
          },
        ],
      },
    },
    {
      title: "onAnswer texts you back.",
      body: "onAnswer runs with the agent's own context, so c.key is your number. It runs inside the agent's run, so an answer that finishes after a restart still gets sent.",
      focus: ["assistant", "phone"],
      status: { assistant: "answered" },
      flows: [
        { edge: "assistant-twilio", label: "onAnswer → sendSms" },
        { edge: "phone-twilio", label: "SMS", back: true },
      ],
      panel: {
        kind: "phone",
        title: "Messages · assistant",
        messages: [
          question,
          {
            role: "assistant",
            text: "It's 18°C and sunny in Tokyo right now.",
          },
        ],
      },
    },
    {
      title: "A duplicate does nothing.",
      body: "If Twilio delivers the same text twice, the server submits it again with the same MessageSid. The agent sees a requestId it already has and does not answer again.",
      focus: ["server", "assistant"],
      status: { assistant: "already submitted" },
      flows: [
        { edge: "twilio-server", label: "POST (same text)" },
        { edge: "server-assistant", label: "submit(same requestId)" },
      ],
      panel: {
        kind: "state",
        title: "assistant · +15551234567",
        rows: [
          ["requestId", "SM7f3a9c…"],
          ["submissions", "2 → 1 run"],
          ["texts sent", "1"],
        ],
      },
    },
  ],
  code: [
    {
      name: "assistant.ts",
      note: "One agent per phone number. onAnswer texts every answer back.",
      source: `import { createRegistry, defineExtension, section } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { getWeather } from "./weather";

const extensions = createRegistry();
extensions.install(
  defineExtension({
    name: "personal-assistant",
    tools: [getWeather],
    sections: [
      section(
        "role",
        () => "You are a personal assistant that talks over SMS. Reply in plain text, without Markdown, in a few short sentences.",
      ),
    ],
  }),
);

// One assistant per user, keyed by their phone number.
export const assistant = pi({
  model: "anthropic/claude-opus-5-5",
  registry: extensions,
  // Texts every answer to the user whose agent this is.
  onAnswer: async (c, answer) => {
    const [phone] = c.key;
    await sendSms(phone, answer.text ?? "Sorry, I couldn't answer that.");
  },
});

async function sendSms(to: string, body: string) {
  // … POST To, From, and Body to Twilio's Messages.json
}`,
    },
    {
      name: "server.ts",
      note: "The webhook checks the sender, submits, and returns without waiting.",
      source: `import { Hono } from "hono";
import { setup } from "rivetkit";
import { createClient } from "rivetkit/client";
import { assistant } from "./assistant";
import { user } from "./user";

export const registry = setup({ use: { user, assistant } });
const client = createClient<typeof registry>();

registry.start();

const app = new Hono();

// Twilio calls this for every text to your number.
app.post("/sms/webhook", async (c) => {
  const params = Object.fromEntries(new URLSearchParams(await c.req.text()));
  if (!verifyTwilioSignature(params, c.req.header("x-twilio-signature") ?? "")) {
    return c.text("invalid signature", 401);
  }

  // Ask the sender's user Actor whether they signed in.
  const phone = params.From;
  if (!(await client.user.getOrCreate([phone]).isSignedIn())) {
    return twiml("<Message>Sign in with this number to talk to your assistant.</Message>");
  }

  // Hand the text to the sender's assistant without waiting for the answer. Their first text creates it.
  // The message id stops a duplicate delivery from running the agent twice.
  await client.assistant.getOrCreate([phone]).submit(params.Body, { requestId: params.MessageSid });
  // An empty response sends nothing. The assistant texts its answer from onAnswer.
  return twiml("");
});

// … serve(), verifyTwilioSignature(), and twiml()`,
    },
  ],
};
