import { google } from "@ai-sdk/google";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OPENROUTER_MODEL,
} from "@example/wire";
import type { LanguageModel } from "ai";

export interface ProviderChoice {
  provider: "openrouter" | "gemini" | "none";
  modelId: string | null;
}

type EnvSource = Record<string, string | undefined>;

/**
 * OpenRouter wins when its key is non-empty after trim.
 * A blank or missing key falls through to Gemini.
 * Both blank means the chat actor should not call a model.
 */
export function chooseProvider(env: EnvSource = process.env): ProviderChoice {
  const openrouterKey = env.OPENROUTER_API_KEY?.trim() ?? "";
  if (openrouterKey) {
    return {
      provider: "openrouter",
      modelId: env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
    };
  }

  const geminiKey = env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ?? "";
  if (geminiKey) {
    return {
      provider: "gemini",
      modelId: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    };
  }

  return { provider: "none", modelId: null };
}

/** Build the AI SDK model for the current environment. */
export function createLanguageModel(
  env: EnvSource = process.env,
): { choice: ProviderChoice; model: LanguageModel | null } {
  const choice = chooseProvider(env);

  if (choice.provider === "openrouter" && choice.modelId) {
    const openrouter = createOpenRouter({
      apiKey: env.OPENROUTER_API_KEY?.trim(),
    });
    return { choice, model: openrouter.chat(choice.modelId) };
  }

  if (choice.provider === "gemini" && choice.modelId) {
    return { choice, model: google(choice.modelId) };
  }

  return { choice, model: null };
}
