import type { registry } from "@example/api/actors";
import {
  CHAT_STATE_LIMIT,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatMessage,
  type ChatResponseEvent,
  type ChatStatusSnapshot,
} from "@example/wire";
import { getActionError, type ReactiveActorHandle } from "@rivetkit/svelte";
import { untrack } from "svelte";
import { actorSocketOptions } from "../actor-socket.js";
import { getRivet } from "../rivet.js";

const STORAGE_KEY = "rivet-svelte-ai.chatId";

type ChatActor = ReactiveActorHandle<typeof registry, "chat">;
type MessagePatch = (messages: ChatMessage[]) => ChatMessage[];

function readChatId(): string {
  try {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // Storage may be denied by browser privacy settings. Keep this chat
    // usable for the current view-model lifetime without persistence.
  }
  return crypto.randomUUID();
}

function applyMessageAdded(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  if (messages.some((item) => item.id === message.id)) return messages;
  return [...messages, message];
}

function applyResponse(
  messages: ChatMessage[],
  event: ChatResponseEvent,
): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === event.messageId);
  if (index === -1) {
    return [
      ...messages,
      {
        id: event.messageId,
        role: "assistant",
        content: event.content,
        createdAt: Date.now(),
      },
    ];
  }

  const next = messages.slice();
  const current = next[index];
  if (!current) return messages;
  next[index] = { ...current, content: event.content };
  return next;
}

/**
 * Owns one chat actor socket. The page reads this class and calls send, stop,
 * and newChat. It does not import the Rivet client.
 */
export class ChatViewModel {
  chatId = $state("");
  /** Replaced wholesale on each snapshot or delta. Not mutated in place. */
  messages = $state.raw<ChatMessage[]>([]);
  /** Actor turn status, separate from the socket status. */
  turn = $state<ChatStatusSnapshot["state"]>("idle");
  draft = $state("");
  error = $state<string | null>(null);
  actor = $state.raw<ChatActor | null>(null);

  #pullId = 0;
  #pulling = false;
  #statusDuringPull = false;
  #pending: MessagePatch[] = [];
  #rivet = getRivet();
  #socketOptions = actorSocketOptions();
  #unmount: (() => void) | null = null;

  constructor() {
    // Re-read the transcript each time this socket connects, including
    // after a drop. The pull is untracked so writing messages cannot
    // re-run the effect.
    $effect(() => {
      const actor = this.actor;
      if (!actor?.isConnected) return;
      const chatId = this.chatId;
      untrack(() => {
        void this.#pullHistory(actor, chatId);
      });
    });
  }

  get connStatus(): string {
    return this.actor?.connStatus ?? "idle";
  }

  get connected(): boolean {
    return this.actor?.isConnected ?? false;
  }

  get sending(): boolean {
    return this.actor?.isMutating ?? false;
  }

  /** Open the socket. Call from the page's browser mount. */
  connect(): () => void {
    this.#open(this.chatId || readChatId());
    return () => this.#close();
  }

  async send(): Promise<void> {
    const text = this.draft.trim();
    if (
      !text ||
      this.sending ||
      this.turn === "thinking" ||
      this.turn === "queued"
    )
      return;
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
      this.error = "That message is too long.";
      return;
    }

    const actor = this.actor;
    if (!actor?.isConnected) {
      this.error = "Not connected yet";
      return;
    }

    this.draft = "";
    this.error = null;

    const result = await actor.sendMessage(text);
    if (this.actor !== actor) return;
    if (result == null) {
      if (!this.draft) this.draft = text;
      this.error =
        getActionError(actor)?.message ?? "Couldn't send — try again";
    }
  }

  async stop(): Promise<void> {
    const actor = this.actor;
    if (!actor) return;

    const result = await actor.cancel();
    if (this.actor !== actor) return;
    if (result == null) {
      this.error = getActionError(actor)?.message ?? "Couldn't stop the reply";
    }
  }

  /** Start a new conversation actor. The previous transcript stays on its actor. */
  newChat(): void {
    this.#pullId += 1;
    this.#pulling = false;
    this.#pending = [];
    this.messages = [];
    this.turn = "idle";
    this.error = null;
    this.draft = "";
    this.#open(crypto.randomUUID());
  }

  #open(chatId: string): void {
    this.#close();
    this.chatId = chatId;
    try {
      sessionStorage.setItem(STORAGE_KEY, chatId);
    } catch {
      // A quota or privacy restriction must not prevent either demo mounting.
    }
    const actor = this.#createActor(chatId);
    this.actor = actor;
    this.#unmount = actor.mount();
  }

  #close(): void {
    this.#pullId += 1;
    this.#pulling = false;
    this.#pending = [];
    this.#unmount?.();
    this.actor?.dispose();
    this.#unmount = null;
    this.actor = null;
  }

  #createActor(chatId: string): ChatActor {
    const actor = this.#rivet.createReactiveActor({
      name: "chat",
      key: ["chat", chatId],
      ...this.#socketOptions,
    });

    actor.onEvent("messageAdded", (message: ChatMessage) => {
      this.#apply((messages) => applyMessageAdded(messages, message));
    });
    actor.onEvent("response", (event: ChatResponseEvent) => {
      this.#apply((messages) => applyResponse(messages, event));
      if (event.done && event.error) this.error = event.error;
      if (event.done && !event.error) this.error = null;
    });
    actor.onEvent("status", (status: ChatStatusSnapshot) => {
      if (this.#pulling) this.#statusDuringPull = true;
      this.turn = status.state;
      if (status.state === "error" && status.error) this.error = status.error;
    });

    return actor;
  }

  #apply(patch: MessagePatch): void {
    if (this.#pulling) {
      this.#pending.push(patch);
      return;
    }
    this.messages = patch(this.messages).slice(-CHAT_STATE_LIMIT);
  }

  async #pullHistory(actor: ChatActor, chatId: string): Promise<void> {
    const pullId = ++this.#pullId;
    this.#pulling = true;
    this.#statusDuringPull = false;
    this.#pending = [];

    const snapshot = await actor.getSnapshot();
    if (
      pullId !== this.#pullId ||
      this.chatId !== chatId ||
      this.actor !== actor
    ) {
      return;
    }

    let messages = snapshot?.messages ?? this.messages;
    for (const patch of this.#pending) {
      messages = patch(messages);
    }
    this.#pending = [];
    this.#pulling = false;
    this.messages = messages.slice(-CHAT_STATE_LIMIT);

    if (snapshot && !this.#statusDuringPull) {
      this.turn = snapshot.status.state;
      this.error = snapshot.status.error ?? null;
    }
    if (!snapshot)
      this.error =
        getActionError(actor)?.message ?? "Could not load conversation.";
  }
}
