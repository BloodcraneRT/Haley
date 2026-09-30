import { useEffect, useRef, useState } from "react";

/** Keep the input in sync with URL navigation and apply typing using the latest URL state. */
export function useDebouncedQuery(query: string, update: (query: string) => void, delay = 250) {
  const [search, setSearch] = useState(query);
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => setSearch(query), [query]);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => updateRef.current(search.trim()), delay);
    return () => window.clearTimeout(timer);
  }, [search, query, delay]);
  return [search, setSearch] as const;
}
