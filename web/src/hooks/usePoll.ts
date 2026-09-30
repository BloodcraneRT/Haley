import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

/** Poll interval in ms, or a function of the latest data (return null/0 to stop polling). */
export type PollInterval<T> = number | null | undefined | ((data: T | undefined) => number | null | undefined);

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  /** True until the first load for the current deps settles. */
  loading: boolean;
  /** Re-fetch now; resolves when done. Keeps showing current data meanwhile. */
  reload: () => Promise<void>;
  /** Locally replace data (optimistic updates). */
  mutate: (update: (data: T | undefined) => T | undefined) => void;
}

/**
 * Fetches on mount and whenever `deps` change, then optionally keeps polling.
 * Stale responses from superseded deps are dropped; polling pauses while the tab is hidden.
 */
export function usePoll<T>(fetcher: () => Promise<T>, deps: DependencyList, interval?: PollInterval<T>): PollState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;
  const dataRef = useRef<T | undefined>(undefined);
  const generation = useRef(0);
  const requestId = useRef(0);
  const mutationId = useRef(0);
  const inFlight = useRef<{ gen: number; promise: Promise<void> } | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);

  const schedule = useCallback((gen: number, run: (gen: number) => Promise<void>) => {
    window.clearTimeout(timer.current);
    const i = intervalRef.current;
    const ms = typeof i === "function" ? i(dataRef.current) : i;
    if (!ms || gen !== generation.current) return;
    timer.current = window.setTimeout(() => {
      if (document.hidden) {
        // Try again later without hitting the server while nobody is looking.
        schedule(gen, run);
        return;
      }
      void run(gen);
    }, ms);
  }, []);

  const run = useCallback(
    (gen: number, force = false): Promise<void> => {
      // Explicit reloads can supersede a pre-write request; automatic refreshes reuse it.
      if (!force && inFlight.current?.gen === gen) return inFlight.current.promise;
      window.clearTimeout(timer.current);
      const id = ++requestId.current;
      const mutation = mutationId.current;
      const fetch = fetcherRef.current;
      const current = () => gen === generation.current && id === requestId.current && mutation === mutationId.current;
      const promise = (async () => {
        try {
          // Defer invocation so even a synchronously thrown fetch error settles after registration.
          const next = await Promise.resolve().then(fetch);
          if (!current()) return;
          dataRef.current = next;
          setData(next);
          setError(undefined);
        } catch (err) {
          if (!current()) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setError(err instanceof Error ? err : new Error(String(err)));
        } finally {
          if (gen === generation.current && id === requestId.current) {
            inFlight.current = undefined;
            setLoading(false);
            schedule(gen, run);
          }
        }
      })();
      inFlight.current = { gen, promise };
      return promise;
    },
    [schedule],
  );

  useEffect(() => {
    const gen = ++generation.current;
    dataRef.current = undefined;
    setData(undefined);
    setError(undefined);
    setLoading(true);
    void run(gen);
    return () => {
      generation.current++;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Refresh promptly when the tab becomes visible again.
  useEffect(() => {
    const onVisible = () => {
      const i = intervalRef.current;
      const ms = typeof i === "function" ? i(dataRef.current) : i;
      if (!document.hidden && ms) void run(generation.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [run]);

  const reload = useCallback(() => run(generation.current, true), [run]);

  const mutate = useCallback((update: (data: T | undefined) => T | undefined) => {
    mutationId.current++;
    const next = update(dataRef.current);
    dataRef.current = next;
    setData(next);
  }, []);

  return { data, error, loading, reload, mutate };
}
