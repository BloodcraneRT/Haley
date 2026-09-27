import { Sparkles } from "lucide-react";

export const isHaley = (name: string) => name.trim().toLowerCase() === "haley";

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

export function Avatar({ name, large }: { name: string; large?: boolean }) {
  if (isHaley(name)) {
    return (
      <span className={`avatar avatar-haley ${large ? "avatar-lg" : ""}`} aria-hidden="true">
        <Sparkles className="icon-sm" />
      </span>
    );
  }
  return (
    <span className={`avatar ${large ? "avatar-lg" : ""}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function displayName(name: string): string {
  return isHaley(name) ? "Haley" : name;
}
