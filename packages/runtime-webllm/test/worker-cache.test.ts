import { describe, expect, it, vi } from "vitest";
import { addCacheEntryIdempotently } from "../src/worker-cache.js";

const request = new Request("https://models.invalid/reviewed-shard.bin");

describe("WebLLM worker cache boundary", () => {
  it("does not inspect the cache after a successful add", async () => {
    const match = vi.fn<Cache["match"]>();
    const add = vi.fn(async () => undefined);

    await addCacheEntryIdempotently({ match }, add, request);

    expect(add).toHaveBeenCalledWith(request);
    expect(match).not.toHaveBeenCalled();
  });

  it("accepts an InvalidAccessError only when the exact entry now exists", async () => {
    const duplicate = new DOMException("Entry already exists.", "InvalidAccessError");
    const match = vi.fn<Cache["match"]>().mockResolvedValue(new Response("cached"));
    const add = vi.fn(async () => { throw duplicate; });

    await expect(addCacheEntryIdempotently({ match }, add, request)).resolves.toBeUndefined();
    expect(match).toHaveBeenCalledWith(request);
  });

  it("rethrows other failures and fake duplicate-shaped objects", async () => {
    const networkFailure = new TypeError("network failed");
    await expect(addCacheEntryIdempotently(
      { match: vi.fn<Cache["match"]>() },
      async () => { throw networkFailure; },
      request,
    )).rejects.toBe(networkFailure);

    const fakeDuplicate = { name: "InvalidAccessError", message: "Entry already exists." };
    const match = vi.fn<Cache["match"]>().mockResolvedValue(new Response("cached"));
    await expect(addCacheEntryIdempotently(
      { match },
      async () => { throw fakeDuplicate; },
      request,
    )).rejects.toBe(fakeDuplicate);
    expect(match).not.toHaveBeenCalled();
  });

  it("rethrows the original duplicate error when no successful entry exists", async () => {
    const duplicate = new DOMException("Entry already exists.", "InvalidAccessError");
    for (const matched of [undefined, new Response("failed", { status: 500 })]) {
      await expect(addCacheEntryIdempotently(
        { match: vi.fn<Cache["match"]>().mockResolvedValue(matched) },
        async () => { throw duplicate; },
        request,
      )).rejects.toBe(duplicate);
    }
  });

  it("preserves the original duplicate error when the verification match rejects", async () => {
    const duplicate = new DOMException("Entry already exists.", "InvalidAccessError");
    await expect(addCacheEntryIdempotently(
      { match: vi.fn<Cache["match"]>().mockRejectedValue(new TypeError("cache unavailable")) },
      async () => { throw duplicate; },
      request,
    )).rejects.toBe(duplicate);
  });
});
