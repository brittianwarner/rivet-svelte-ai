import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseProvider } from "./model.ts";

describe("chooseProvider", () => {
  it("uses OpenRouter when that key is set", () => {
    const choice = chooseProvider({
      OPENROUTER_API_KEY: "sk-or-test",
      GOOGLE_GENERATIVE_AI_API_KEY: "gemini-test",
    });

    assert.equal(choice.provider, "openrouter");
    assert.equal(choice.modelId, "z-ai/glm-5.3-flash");
  });

  it("uses an OpenRouter model override", () => {
    const choice = chooseProvider({
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_MODEL: "google/gemini-2.5-flash",
    });

    assert.equal(choice.provider, "openrouter");
    assert.equal(choice.modelId, "google/gemini-2.5-flash");
  });

  it("falls through to Gemini when the OpenRouter key is blank", () => {
    const choice = chooseProvider({
      OPENROUTER_API_KEY: "   ",
      GOOGLE_GENERATIVE_AI_API_KEY: "gemini-test",
      GEMINI_MODEL: "gemini-3.8-flash",
    });

    assert.equal(choice.provider, "gemini");
    assert.equal(choice.modelId, "gemini-3.8-flash");
  });

  it("returns none when both keys are blank", () => {
    const choice = chooseProvider({
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "  ",
    });

    assert.deepEqual(choice, { provider: "none", modelId: null });
  });
});
