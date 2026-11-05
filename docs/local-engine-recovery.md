# Local engine recovery investigation

This is a reproducible diagnostic report for upstream follow-up. It describes local testing only; no deployed environment was tested.

## Symptoms

An isolated engine and API/actor runner successfully created a counter with value 7 and a completed two-message chat transcript. The test waited six seconds for checkpointing, terminated both processes, then started them again with the same temporary engine storage. Subsequent actor reads did not complete successfully within the test run.

Observed errors included:

- `depot/overloaded`: `routing_unavailable`; retry after 100 ms.
- `depot/unavailable`: `command_capacity`; the command outcome may be unknown.
- `guard/request_timeout`: timed out waiting for the actor to become ready.

These observations establish neither data loss nor successful recovery. Restarting only the API/actor runner while its engine remains running passes the counter and transcript assertions.

## Reproduction

```bash
bun install --frozen-lockfile
FULL_ENGINE_RESTART=1 bun run test:restart
```

The test entry is `apps/api/tests/restart.ts`; `apps/api/tests/engine.ts` launches the engine binary directly with temporary topology, log, and object-storage paths. Model credentials are blank. The engine uses ports 6550–6552 and the API uses 3003. No developer engine is stopped or reused.

## What was tried

- Explicit standalone engine launch to avoid Rivet's automatic launcher sharing its global runtime stamp and configuration.
- Reusing the same temporary log and file object-storage directories across engine restarts.
- Matching the automatic launcher's local storage and shutdown settings, including a five-second cold-write interval, six-second storage stop timeout, and two-second teardown interval.
- Waiting for engine HTTP availability and API health before actor requests, followed by the SDK's lifecycle retries. HTTP availability did not establish storage or actor readiness.
- Independent runner-only restart with the same assertions; this passed.

## Environment

- RivetKit and Engine: 3.0.1.
- Runtime: Node 26.13.0; Bun 1.4.4 manages workspace dependencies.
- Host: macOS, Apple Silicon (arm64).
- HTTP router: Hono 4.13.16; long-running actor runner.
- Storage: local engine with temporary log and file object storage.
- AI provider: none; deterministic missing-provider completion.
- Deployment provider: none; local process test.

Share this report and the reproduction script through [Rivet GitHub](https://github.com/rivet-dev/rivet/issues) or [Rivet Discord](https://rivet.dev/discord) when qualifying full engine recovery. No upstream issue or message has been submitted by this task.
