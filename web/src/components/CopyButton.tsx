import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { copyText } from "../lib/clipboard";

export function CopyButton({ value, label = "Copy", className = "btn btn-sm" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      aria-label={copied ? "Copied" : `${label}: ${value}`}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1800);
        }
      }}
    >
      {copied ? <Check className="icon-sm" aria-hidden="true" /> : <Copy className="icon-sm" aria-hidden="true" />}
      {copied ? "Copied" : label}
    </button>
  );
}
