import type { ExampleStory } from "../types";

export const signInWithChatgpt: ExampleStory = {
  slug: "sign-in-with-chatgpt",
  section: "agents",
  title: "Sign in with ChatGPT",
  tagline:
    "Run each user's agent on their own ChatGPT plan, with no OpenAI API key of yours.",
  ideas: [
    "One chatgptLogin actor per user runs the sign-in and saves the result.",
    "The credentials actor hands out access tokens and keeps the refresh token to itself.",
    "The agent reads the credential before every model call, so it works as soon as the user signs in.",
  ],
  docs: "https://rivet.dev/guides/sign-in-with-chatgpt/",
  requires: [
    {
      label: "@rivet-dev/pi + @earendil-works/pi-durable",
      detail:
        "The agent. The guide also installs pi-ai and pi-coding-agent for the login and token refresh.",
    },
    {
      label: "CHATGPT_HOST_ID",
      detail: "A UUID you generate once and keep across deploys. Not a secret.",
    },
    {
      label: "ChatGPT Plus or Pro",
      detail:
        "Each user signs in with their own plan. Usage counts against it.",
    },
    {
      label: "Open-source or self-hosted app",
      detail: "Paid or hosted apps must fill out OpenAI's interest form first.",
    },
  ],
  nodes: [
    {
      id: "you",
      label: "Your app",
      kind: "client",
      key: "user-123",
      x: 14,
      y: 30,
    },
    {
      id: "login",
      label: "chatgptLogin",
      kind: "actor",
      key: "user-123",
      x: 46,
      y: 12,
    },
    {
      id: "openai",
      label: "OpenAI",
      kind: "service",
      key: "sign-in",
      x: 84,
      y: 12,
    },
    {
      id: "creds",
      label: "credentials",
      kind: "actor",
      key: "user-123",
      x: 46,
      y: 48,
    },
    {
      id: "agent",
      label: "agent",
      kind: "agent",
      key: "user-123, chat",
      x: 84,
      y: 48,
    },
  ],
  edges: [
    { id: "you-login", from: "you", to: "login" },
    { id: "login-openai", from: "login", to: "openai" },
    { id: "openai-you", from: "openai", to: "you" },
    { id: "login-creds", from: "login", to: "creds" },
    { id: "you-agent", from: "you", to: "agent" },
    { id: "agent-creds", from: "agent", to: "creds" },
    { id: "agent-openai", from: "agent", to: "openai" },
  ],
  beats: [
    {
      title: "Start the sign-in.",
      body: "The user picks Continue with ChatGPT. Your app calls start on the user's chatgptLogin actor, which begins pi-ai's sign-in and returns the URL to open.",
      enter: ["you", "login"],
      focus: ["login"],
      status: { login: "waiting" },
      flows: [{ edge: "you-login", label: "start()" }],
      panel: {
        kind: "state",
        title: "chatgptLogin · user-123",
        rows: [
          ["returns", "sign-in URL"],
          ["start again", "cancels the one in progress"],
          ["gives up after", "10 minutes"],
          ["listens on", "port 1455 during sign-in"],
        ],
      },
    },
    {
      title: "Choose Continue at OpenAI.",
      body: "Your app opens the URL in a new tab. The user signs in to ChatGPT and sees your app's name on the consent screen.",
      enter: ["openai"],
      focus: ["you", "openai"],
      status: { login: "waiting", openai: "consent" },
      flows: [{ edge: "openai-you", label: "open sign-in URL", back: true }],
      panel: {
        kind: "state",
        title: "consent tab",
        rows: [
          ["app name", "Acme"],
          ["agent host ID", "CHATGPT_HOST_ID"],
          ["plan", "the user's ChatGPT Plus or Pro"],
          ["button", "Continue"],
        ],
      },
    },
    {
      title: "Paste back the redirect.",
      body: "OpenAI sends the browser to a 127.0.0.1 address. When the worker runs on another machine, that page does not load, so the user copies its URL into your app.",
      focus: ["you"],
      status: { login: "waiting", openai: "redirected" },
      flows: [{ edge: "openai-you", label: "127.0.0.1:1455/auth/callback" }],
      panel: {
        kind: "terminal",
        title: "client.ts",
        lines: [
          { text: "Open this URL and choose Continue:", tone: "muted" },
          { text: "https://…", tone: "muted" },
          {
            text: "Paste the URL you landed on, or press Enter if the page says you can close it:",
            tone: "event",
          },
          {
            text: "http://127.0.0.1:1455/auth/callback?code=…",
            tone: "command",
          },
        ],
      },
    },
    {
      title: "Finish exchanges the code.",
      body: "finish hands the pasted URL to the waiting sign-in. pi-ai trades the code with OpenAI for tokens. If the worker shares a machine with the browser, the URL is optional.",
      focus: ["login", "openai"],
      status: { login: "exchanging" },
      flows: [
        { edge: "you-login", label: "finish(url)" },
        { edge: "login-openai", label: "exchange code" },
      ],
      panel: {
        kind: "state",
        title: "chatgptLogin · user-123",
        rows: [
          ["pending sign-in", "redirect received"],
          ["exchange", "code for tokens"],
          ["on failure", "UserError with the reason"],
          ["afterwards", "pending cleared"],
        ],
      },
    },
    {
      title: "Save the login.",
      body: "The login is saved to the user's credentials actor under the provider id openai. It is the only place the refresh token lives.",
      enter: ["creds"],
      focus: ["creds"],
      status: { creds: "saved" },
      flows: [{ edge: "login-creds", label: 'save("openai")' }],
      panel: {
        kind: "state",
        title: "credentials · user-123",
        rows: [
          ["provider", "openai"],
          ["type", "oauth"],
          ["access token", "stored"],
          ["refresh token", "stored, never returned"],
        ],
      },
    },
    {
      title: "The agent gets an access token.",
      body: "The agent's key starts with the user id, so it reads that user's credentials. read strips the refresh token. refresh renews the access token when it has less than ten minutes left.",
      enter: ["agent"],
      focus: ["agent", "creds"],
      status: { creds: "refresh kept", agent: "has token" },
      flows: [{ edge: "agent-creds", label: 'read("openai")' }],
      panel: {
        kind: "state",
        title: "what the agent receives",
        rows: [
          ["type", "oauth"],
          ["access token", "yes"],
          ["refresh token", "removed by read()"],
          ["checked", "before every model call"],
        ],
      },
    },
    {
      title: "The agent runs on the user's plan.",
      body: "Your app prompts the agent as usual. The model call uses the user's ChatGPT plan, and you never held an OpenAI API key.",
      focus: ["agent", "openai"],
      status: { creds: "refresh kept", agent: "answering" },
      flows: [
        { edge: "you-agent", label: "prompt()" },
        { edge: "agent-openai", label: "Responses API" },
      ],
      panel: {
        kind: "chat",
        title: "agent · user-123, chat",
        messages: [
          { role: "user", text: "Say hi in five words." },
          { role: "assistant", text: "Hi, good to meet you.", streaming: true },
        ],
      },
    },
    {
      title: "Know the limits.",
      body: "Plan tokens only work with the Responses API. Each worker runs one sign-in at a time, because pi-ai holds port 1455 until the sign-in ends.",
      focus: ["login", "openai"],
      status: { login: "one per worker" },
      panel: {
        kind: "state",
        title: "restrictions",
        rows: [
          ["apps", "open-source and self-hosted; others ask OpenAI"],
          ["API", "Responses only, no classifier models"],
          ["usage", "counts against the user's plan"],
          ["sign-ins", "one per worker at a time"],
          ["both actors", "need authentication"],
        ],
      },
    },
  ],
  code: [
    {
      name: "credentials.ts",
      note: "Keeps the login and never hands out the refresh token.",
      source: `import { type Credential, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PiProviderCredential } from "@rivet-dev/pi";
import { actor } from "rivetkit";

// One per user. Holds the user's ChatGPT login and gives the agent fresh access tokens.
export const credentials = actor({
  state: { saved: {} as Record<string, Credential> },
  actions: {
    save: (c, provider: string, credential: Credential) => {
      c.state.saved[provider] = credential;
    },
    read: (c, provider: string) => withoutRefreshToken(c.state.saved[provider]),
    refresh: async (c, provider: string) => {
      const store = new InMemoryCredentialStore();
      await store.modify(provider, async () => c.state.saved[provider]);
      const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null });
      await runtime.getAuth(provider, { minOAuthValidityMs: 10 * 60_000 });
      const refreshed = await store.read(provider);
      if (refreshed) c.state.saved[provider] = refreshed;
      return withoutRefreshToken(refreshed);
    },
    // … list
  },
});

function withoutRefreshToken(credential: Credential | undefined): PiProviderCredential | undefined {
  if (credential?.type !== "oauth") return credential;
  const { refresh: _refresh, ...rest } = credential;
  return rest;
}`,
    },
    {
      name: "chatgpt-login.ts",
      note: "start returns the sign-in URL; finish takes the pasted redirect and saves the login.",
      source: `export const chatgptLogin = actor({
  createVars: () => ({ pending: undefined as PendingSignIn | undefined }),
  actions: {
    start: async (c) => {
      c.vars.pending?.cancel();
      const models = createModels({ credentials: new InMemoryCredentialStore() });
      models.setProvider(openaiProvider());
      const cancel = new AbortController();
      const authUrl = Promise.withResolvers<string>();
      const redirect = Promise.withResolvers<string>();
      const credential = models.login("openai", "oauth", {
        // Give up after ten minutes, or when the user starts over.
        signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(10 * 60_000)]),
        notify: (event) => {
          if (event.type === "auth_url") authUrl.resolve(event.url);
        },
        // pi-ai asks for the redirect URL the browser landed on.
        prompt: ({ signal }) =>
          new Promise<string>((resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true });
            redirect.promise.then(resolve);
          }),
      }, { getDeviceId: () => HOST_ID, agentName: APP_NAME });
      c.vars.pending = { cancel: () => cancel.abort(), pasteRedirect: redirect.resolve, credential };
      c.keepAwake(credential.catch(() => undefined));
      return Promise.race([authUrl.promise, credential.then(() => authUrl.promise)]);
    },
    finish: async (c, redirectUrl?: string) => {
      const pending = c.vars.pending;
      if (!pending) throw new UserError("Start a sign-in first.");
      if (redirectUrl) pending.pasteRedirect(redirectUrl);
      try {
        const credential = await pending.credential;
        const client = c.client<Registry<{ credentials: typeof credentials }>>();
        await client.credentials.getOrCreate([c.key[0]]).save("openai", credential);
      } catch (error) {
        throw new UserError(error instanceof Error ? error.message : "ChatGPT sign-in failed.");
      } finally {
        c.vars.pending = undefined;
      }
    },
  },
});`,
    },
    {
      name: "server.ts",
      note: "The agent's key starts with the user id, so it reads that user's credentials.",
      source: `import { createRegistry } from "@earendil-works/pi-durable";
import { pi } from "@rivet-dev/pi";
import { type Registry, setup } from "rivetkit";
import { chatgptLogin } from "./chatgpt-login";
import { credentials } from "./credentials";

const agent = pi({
  model: "openai/gpt-6-sol",
  registry: createRegistry(),
  // The agent's key starts with the user id, so it runs on that user's ChatGPT plan.
  credentials: (c) => {
    const client = c.client<Registry<{ credentials: typeof credentials }>>();
    return client.credentials.getOrCreate([c.key[0]]);
  },
});

export const registry = setup({ use: { credentials, chatgptLogin, agent } });

registry.start();`,
    },
  ],
};
