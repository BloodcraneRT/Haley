import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDebouncedQuery } from "../src/hooks/useDebouncedQuery";
import { renderHook } from "./renderHook";

describe("URL-backed searches", () => {
  it("preserves a client filter changed while typing is debounced", async () => {
    vi.useFakeTimers();
    let params = new URLSearchParams("orgId=first");
    const hook = await renderHook(() => {
      const snapshot = params;
      return useDebouncedQuery(params.get("q") ?? "", (query) => {
        const next = new URLSearchParams(snapshot);
        next.set("q", query);
        params = next;
      });
    });
    await act(async () => hook.result[1]("  password  "));
    params = new URLSearchParams("orgId=second&status=escalated");
    await hook.rerender();
    await act(async () => vi.advanceTimersByTime(250));
    expect(params.get("q")).toBe("password");
    expect(params.get("orgId")).toBe("second");
    expect(params.get("status")).toBe("escalated");
  });

  it("shows a navigated URL query and cancels stale pending input", async () => {
    vi.useFakeTimers();
    let query = "before";
    const update = vi.fn();
    const hook = await renderHook(() => useDebouncedQuery(query, update));
    await act(async () => hook.result[1]("pending typing"));
    query = "from navigation";
    await hook.rerender();
    expect(hook.result[0]).toBe("from navigation");
    await act(async () => vi.advanceTimersByTime(250));
    expect(update).not.toHaveBeenCalled();
  });
});
