import type { Principal } from "@example/entities/contracts";
import { createContext } from "svelte";

const PERSONA_KEY = "rivet-svelte-ai.persona";
/** Re-sign this long before expiry, so a reconnect never carries a stale token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface SignInResponse {
  principal: Principal;
  token: string;
  /** Seconds the token lives. Relative, so clocks never have to agree. */
  expiresIn: number;
}

interface IssuedToken {
  principal: Principal;
  token: string;
  /** Local epoch milliseconds. */
  expiresAt: number;
}

function readSaved(): string | null {
  try {
    // Per tab first, so two tabs can be two people watching the same org.
    return (
      sessionStorage.getItem(PERSONA_KEY) ?? localStorage.getItem(PERSONA_KEY)
    );
  } catch {
    return null;
  }
}

function save(sub: string | null): void {
  try {
    if (sub) {
      sessionStorage.setItem(PERSONA_KEY, sub);
      localStorage.setItem(PERSONA_KEY, sub);
    } else {
      sessionStorage.removeItem(PERSONA_KEY);
      localStorage.removeItem(PERSONA_KEY);
    }
  } catch {
    /* Storage denial only costs the remembered persona. */
  }
}

/**
 * Who the browser is acting as. Signs in through `/api/entities/sign-in` and
 * hands out a fresh principal token on every actor connect.
 *
 * The token lives in memory only. Storage keeps the persona id, never the token.
 */
export class PrincipalViewModel {
  personas = $state.raw<Principal[]>([]);
  current = $state.raw<Principal | null>(null);
  loading = $state(true);
  pending = $state<string | null>(null);
  error = $state<string | null>(null);

  #token: string | null = null;
  #expiresAt = 0;
  #refreshing: Promise<string> | null = null;
  #generation = 0;

  get signedIn(): boolean {
    return this.current !== null;
  }

  /** Load the personas and restore the last one used in this tab. */
  async start(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const response = await fetch("/api/entities/personas");
      if (!response.ok) throw new Error("Could not load people.");
      const body = (await response.json()) as { personas: Principal[] };
      this.personas = body.personas;
      const saved = readSaved();
      if (saved && body.personas.some((persona) => persona.sub === saved))
        await this.signIn(saved);
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Could not load people.";
    } finally {
      this.loading = false;
    }
  }

  async signIn(sub: string): Promise<boolean> {
    if (this.current?.sub === sub && this.#fresh()) return true;
    const generation = ++this.#generation;
    this.pending = sub;
    this.error = null;
    try {
      const next = await this.#request(sub);
      if (generation !== this.#generation) return false;
      this.#token = next.token;
      this.#expiresAt = next.expiresAt;
      this.current = next.principal;
      save(sub);
      return true;
    } catch (error) {
      if (generation === this.#generation)
        this.error =
          error instanceof Error ? error.message : "Could not sign in.";
      return false;
    } finally {
      if (generation === this.#generation) this.pending = null;
    }
  }

  signOut(): void {
    this.#generation++;
    this.#token = null;
    this.#expiresAt = 0;
    this.#refreshing = null;
    this.current = null;
    save(null);
  }

  /**
   * A token good for at least five more minutes. Actor view models call this
   * from `getParams`, which runs on every connect and reconnect.
   */
  async token(): Promise<string> {
    const sub = this.current?.sub;
    if (!sub) throw new Error("Choose who to sign in as.");
    if (this.#token && this.#fresh()) return this.#token;
    this.#refreshing ??= this.#request(sub)
      .then((next) => {
        if (this.current?.sub !== sub)
          throw new Error("Signed in as someone else.");
        this.#token = next.token;
        this.#expiresAt = next.expiresAt;
        return next.token;
      })
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  #fresh(): boolean {
    return Date.now() < this.#expiresAt - REFRESH_MARGIN_MS;
  }

  async #request(sub: string): Promise<IssuedToken> {
    const sentAt = Date.now();
    const response = await fetch("/api/entities/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona: sub }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429)
      throw new Error("Too many sign-ins. Try again in a minute.");
    if (!response.ok) throw new Error("Could not sign in.");
    const body = (await response.json()) as SignInResponse;
    // Count from when the request left, so the token never outlives our estimate.
    return { ...body, expiresAt: sentAt + body.expiresIn * 1000 };
  }
}

export const [getPrincipal, setPrincipal] = createContext<PrincipalViewModel>();
