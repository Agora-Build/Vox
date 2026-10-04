import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPreview, previewRetryDelay } from "../client/src/lib/preview-fetch";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("bounded preview request retries", () => {
  it("honors bounded Retry-After seconds/dates and otherwise backs off", () => {
    expect(previewRetryDelay("3", 0)).toBe(3000);
    expect(previewRetryDelay("0", 2)).toBe(2000);
    expect(previewRetryDelay(null, 1)).toBe(1000);
    expect(previewRetryDelay("bad", 0)).toBe(500);
    expect(previewRetryDelay("Infinity", 0)).toBe(500);
    expect(previewRetryDelay("3600", 0)).toBe(5000);
    expect(previewRetryDelay("Thu, 01 Jan 1970 00:00:03 GMT", 0, 0)).toBe(3000);
  });
  it("returns successful and non-retryable responses without extra requests", async () => {
    for (const status of [200, 401, 403, 413, 502]) {
      const response = new Response("fixture", { status });
      const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
      expect(await fetchPreview("/preview", new AbortController().signal)).toBe(response);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });
  it("cancels a 429 body and retries after Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    const busy = new Response("busy", { status: 429, headers: { "Retry-After": "1" } });
    const cancel = vi.spyOn(busy.body!, "cancel");
    const ready = new Response("fixture");
    const fetch = vi.fn().mockResolvedValueOnce(busy).mockResolvedValue(ready); vi.stubGlobal("fetch", fetch);
    const pending = fetchPreview("/preview", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(999); expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(ready);
    expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("gives a distinct busy error after four attempts instead of retrying forever", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("busy", { status: 429 })); vi.stubGlobal("fetch", fetch);
    const pending = fetchPreview("/preview", new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("Preview busy");
    await vi.runAllTimersAsync(); await rejected;
    expect(fetch).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts waiting retries immediately without issuing another fetch", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("busy", { status: 429 })); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = fetchPreview("/preview", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100); controller.abort(); await rejected;
    expect(fetch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("does not fetch when the caller has already cancelled", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); controller.abort();
    await expect(fetchPreview("/preview", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
