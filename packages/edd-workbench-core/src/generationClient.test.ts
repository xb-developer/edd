import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAnswer } from "./generationClient.js";

describe("generateAnswer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GENERATION_SERVICE_URL;
  });

  it("throws if GENERATION_SERVICE_URL isn't set, without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(generateAnswer([{ role: "user", content: "hi" }])).rejects.toThrow("GENERATION_SERVICE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to /v1/chat/completions with enable_thinking disabled and returns the content plus token usage", async () => {
    process.env.GENERATION_SERVICE_URL = "http://vllm.internal:8000";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "  A grounded answer.  " } }],
        usage: { prompt_tokens: 45, completion_tokens: 19, total_tokens: 64 },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await generateAnswer([{ role: "user", content: "What happened?" }]);

    expect(result).toEqual({ content: "A grounded answer.", totalTokens: 64 });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("defaults totalTokens to 0 if the response omits usage", async () => {
    process.env.GENERATION_SERVICE_URL = "http://vllm.internal:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "answer" } }] }) }),
    );

    const result = await generateAnswer([{ role: "user", content: "hi" }]);

    expect(result.totalTokens).toBe(0);
  });

  it("throws with the response body when the request fails", async () => {
    process.env.GENERATION_SERVICE_URL = "http://vllm.internal:8000";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "model not loaded" }));

    await expect(generateAnswer([{ role: "user", content: "hi" }])).rejects.toThrow("model not loaded");
  });
});
