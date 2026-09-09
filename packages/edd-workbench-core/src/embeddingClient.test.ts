import { afterEach, describe, expect, it, vi } from "vitest";
import { embedTexts } from "./embeddingClient.js";

describe("embedTexts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.EMBEDDING_SERVICE_URL;
  });

  it("throws if EMBEDDING_SERVICE_URL isn't set, without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(embedTexts(["a"])).rejects.toThrow("EMBEDDING_SERVICE_URL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to /v1/embeddings with the model/dimensions and returns embeddings in index order plus token usage", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://vllm.internal:8000";
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, embedding: [0.2] },
          { index: 0, embedding: [0.1] },
        ],
        usage: { total_tokens: 42 },
      }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await embedTexts(["first", "second"]);

    expect(result).toEqual({ embeddings: [[0.1], [0.2]], totalTokens: 42 });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://vllm.internal:8000/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ model: "Qwen/Qwen3-Embedding-0.6B", input: ["first", "second"], dimensions: 1024 });
  });

  it("defaults totalTokens to 0 if the response omits usage", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://vllm.internal:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }) }),
    );

    const result = await embedTexts(["first"]);

    expect(result.totalTokens).toBe(0);
  });

  it("throws with the response body when the request fails", async () => {
    process.env.EMBEDDING_SERVICE_URL = "http://vllm.internal:8000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "model not loaded" }),
    );

    await expect(embedTexts(["a"])).rejects.toThrow("model not loaded");
  });
});
