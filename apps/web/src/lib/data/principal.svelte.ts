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

export interface IssuedToken {
  principal: Principal;
  token: string;
  /** Local epoch milliseconds. */
  expiresAt: number;
}

/** The persona this tab used last, if any. */
export function savedPersona(): string | null {
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

/** Sign one persona in. Relative expiry, so clocks never have to agree. */
export async function requestToken(
  sub: string,
  fetcher: typeof fetch = fetch,
): Promise<IssuedToken> {
  const sentAt = Date.now();
  const response = await fetcher("/api/entities/sign-in", {
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

/** What the `/data` layout load already started, so nothing waits in line. */
export interface PrincipalPreload {
  personas: Promise<Principal[]>;
  /** The remembered persona's sign-in, already in flight. */
  session: { sub: string; token: Promise<IssuedToken> } | null;
}

/** Start every request the sign-in screen needs at once. For a load function. */
export function preloadPrincipal(fetcher: typeof fetch): PrincipalPreload {
  const personas = fetcher("/api/entities/personas").then(async (response) => {
    if (!response.ok) throw new Error("Could not load people.");
    return ((await response.json()) as { personas: Principal[] }).personas;
  });
  const sub = savedPersona();
  const session = sub ? { sub, token: requestToken(sub, fetcher) } : null;
  // Handled in `start`; keep an early failure from being reported unhandled.
  personas.catch(() => {});
  session?.token.catch(() => {});
  return { personas, session };
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

  /** A remembered person is signing back in. Draw nothing, not the sign-in screen. */
  restoring = $state(false);

  /** Pass `restoring` when a remembered sign-in is already in flight. */
  constructor(options: { restoring?: boolean } = {}) {
    this.restoring = options.restoring ?? false;
  }

  get signedIn(): boolean {
    return this.current !== null;
  }

  /**
   * Load the personas and restore the last one used in this tab. With a
   * preload, both requests are already running.
   */
  async start(preload?: PrincipalPreload): Promise<void> {
    const { personas, session } = preload ?? preloadPrincipal(fetch);
    this.loading = true;
    this.error = null;
    const generation = this.#generation;
    if (session) {
      this.pending = session.sub;
      this.restoring = true;
    }
    try {
      this.personas = await personas;
      if (session && this.personas.some((p) => p.sub === session.sub)) {
        const next = await session.token.catch(() => null);
        // A click on someone else while this was in flight wins.
        if (next && generation === this.#generation) this.#adopt(next);
        else if (!next && generation === this.#generation)
          await this.signIn(session.sub);
      }
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Could not load people.";
    } finally {
      if (generation === this.#generation) this.pending = null;
      this.restoring = false;
      this.loading = false;
    }
  }

  async signIn(sub: string): Promise<boolean> {
    if (this.current?.sub === sub && this.#fresh()) return true;
    const generation = ++this.#generation;
    this.pending = sub;
    this.error = null;
    try {
      const next = await requestToken(sub);
      if (generation !== this.#generation) return false;
      this.#adopt(next);
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
    this.#refreshing ??= requestToken(sub)
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

  #adopt(next: IssuedToken): void {
    this.#token = next.token;
    this.#expiresAt = next.expiresAt;
    this.current = next.principal;
    save(next.principal.sub);
  }

  #fresh(): boolean {
    return Date.now() < this.#expiresAt - REFRESH_MARGIN_MS;
  }
}

export const [getPrincipal, setPrincipal] = createContext<PrincipalViewModel>();
