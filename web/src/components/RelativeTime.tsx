import { useNow } from "../hooks/useNow";
import { absoluteTime, relativeTime } from "../lib/format";

export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!iso) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={absoluteTime(iso)} className={className ?? "nowrap"}>
      {relativeTime(iso, now)}
    </time>
  );
}
