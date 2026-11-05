import type { ProviderStatus } from "@example/wire";

/** Reads which model the API process will call, with retry and scoped cancellation. */
export class ProviderViewModel {
  provider = $state<ProviderStatus["provider"]>("none");
  model = $state<string | null>(null);
  error = $state<string | null>(null);
  loading = $state(true);
  #request: AbortController | undefined;

  async load(): Promise<void> {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    this.loading = true;
    this.error = null;
    try {
      const response = await fetch("/api/ready", {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok)
        throw new Error("Could not check the AI configuration.");
      const body = (await response.json()) as ProviderStatus;
      if (
        !["none", "openrouter", "gemini"].includes(body.provider) ||
        !(body.model === null || typeof body.model === "string")
      ) {
        throw new Error("The API returned an invalid AI configuration.");
      }
      if (request.signal.aborted) return;
      this.provider = body.provider;
      this.model = body.model;
    } catch {
      if (!request.signal.aborted)
        this.error =
          "Could not check the AI configuration. Check that the API is running, then retry.";
    } finally {
      if (this.#request === request && !request.signal.aborted)
        this.loading = false;
    }
  }

  dispose(): void {
    this.#request?.abort();
  }
}
