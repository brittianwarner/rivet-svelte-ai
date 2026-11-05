# Contributing

Use Node 26 and Bun 1.4.4. Install from the root with `bun install --frozen-lockfile`.

## Working with coding agents

Shared repository guidance lives in [AGENTS.md](AGENTS.md). Codex reads it directly; [CLAUDE.md](CLAUDE.md) imports the same file for Claude Code, including versions or configurations without native `AGENTS.md` loading. Update the shared file instead of maintaining separate instructions for each tool.

Keep instructions concise and specific to this repository. Put longer explanations in `docs/` and link them from the guide. Do not add machine-specific paths, credentials, temporary task status, or historical test counts. After changing instructions, start a fresh agent session and ask it to summarize the repository rules; in Claude Code, `/memory` also shows loaded instruction files.

See the official [Codex instruction-file guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [Claude Code memory guide](https://code.claude.com/docs/en/memory) for discovery and import behavior.

## Pull request checks

Before opening a pull request:

```bash
bun run format:check
bun run validate
bunx playwright install chromium
bun run test:e2e:production
```

Keep actor rules in `apps/api`, browser projections in view models, and presentation in components. Use Svelte 5 runes, typed events, runtime input validation, compound keys, and bounded state. Never import runtime server code into the web app. Document lifecycle and retry semantics for new background work.

Add behavior tests for changed contracts or lifecycle guarantees. Use local engines and fake providers for repeatable tests; do not require paid credentials in CI. Browser tests have their own ports. The main suite blanks provider keys; the AI suite uses a test-process-only fetch transport with a dummy key and exercises the optional chat actor through the real provider SDK and socket client without paid calls. Do not run two browser suites concurrently on those same ports.

The workspace adapter has its own Apache-2.0 license and detailed API reference. Preserve upstream bridge attribution. Its existing source formatting is excluded from the starter-wide formatter to keep application changes reviewable.

Svelte checking uses TypeScript 7 through `@typescript/native` and `svelte-check --tsgo`. The Svelte workspaces also install TypeScript 6 because Svelte tooling still requires its compiler API. Keep this compatibility dependency until Svelte supports TypeScript 7 without it. The API uses TypeScript 7 directly.
