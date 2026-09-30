import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { usePoll } from "../src/hooks/usePoll";
import { deferred, renderHook } from "./renderHook";

describe("usePoll", () => {
  it("keeps the newest response when explicit reloads overlap", async () => {
    const initial = deferred<string>();
    const older = deferred<string>();
    const newer = deferred<string>();
    const fetcher = vi.fn().mockReturnValueOnce(initial.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const hook = await renderHook(() => usePoll<string>(fetcher, []));
    await act(async () => initial.resolve("initial"));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = hook.result.reload(); second = hook.result.reload(); });
    await act(async () => { newer.resolve("newer"); await second; });
    await act(async () => { older.resolve("older"); await first; });
    expect(hook.result.data).toBe("newer");
  });

  it("clears old data and errors when the requested record changes", async () => {
    const next = deferred<string>();
    let id = "first";
    const fetcher = vi.fn().mockResolvedValueOnce("first record").mockRejectedValueOnce(new Error("refresh failed")).mockReturnValueOnce(next.promise);
    const hook = await renderHook(() => usePoll<string>(fetcher, [id]));
    await act(async () => { await hook.result.reload(); });
    expect(hook.result.data).toBe("first record");
    expect(hook.result.error?.message).toBe("refresh failed");
    id = "second";
    await hook.rerender();
    expect(hook.result.data).toBeUndefined();
    expect(hook.result.error).toBeUndefined();
    expect(hook.result.loading).toBe(true);
    await act(async () => next.resolve("second record"));
    expect(hook.result.data).toBe("second record");
  });

  it("does not replace an optimistic mutation with an already pending response", async () => {
    const refresh = deferred<string>();
    const fetcher = vi.fn().mockResolvedValueOnce("saved").mockReturnValueOnce(refresh.promise).mockResolvedValueOnce("confirmed");
    const hook = await renderHook(() => usePoll<string>(fetcher, []));
    let request!: Promise<void>;
    await act(async () => { request = hook.result.reload(); hook.result.mutate(() => "optimistic"); });
    await act(async () => { refresh.resolve("old saved"); await request; });
    expect(hook.result.data).toBe("optimistic");
    await act(async () => { await hook.result.reload(); });
    expect(hook.result.data).toBe("confirmed");
  });

  it("reuses an in-flight request for automatic visibility refreshes", async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);
    const hook = await renderHook(() => usePoll(fetcher, [], 1000));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve("loaded"));
    expect(hook.result.data).toBe("loaded");
  });

  it("respects a stopped dynamic interval when the tab becomes visible", async () => {
    const fetcher = vi.fn().mockResolvedValue("complete");
    await renderHook(() => usePoll<string>(fetcher, [], (data) => data === "complete" ? null : 1000));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recovers on the next automatic poll when a fetcher throws synchronously", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(() => { throw new Error("synchronous failure"); }).mockResolvedValue("recovered");
    const hook = await renderHook(() => usePoll<string>(fetcher, [], 1000));
    expect(hook.result.error?.message).toBe("synchronous failure");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(hook.result.data).toBe("recovered");
    expect(hook.result.error).toBeUndefined();
  });
});
