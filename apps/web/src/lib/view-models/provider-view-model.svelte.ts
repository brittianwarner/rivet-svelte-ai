import type { ProviderStatus } from "@example/wire";

/** Reads which model the API process will call. */
export class ProviderViewModel {
  provider = $state<ProviderStatus["provider"]>("none");
  model = $state<string | null>(null);
  error = $state<string | null>(null);

  async load(): Promise<void> {
    try {
      const response = await fetch("/api/ready");
      if (!response.ok) {
        this.error = "The API is not ready.";
        return;
      }
      const body = (await response.json()) as ProviderStatus;
      this.provider = body.provider;
      this.model = body.model;
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The API is not ready.";
    }
  }
}
