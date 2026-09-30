import { Braces, Headset, MessageSquareText, MonitorCog, NotebookText } from "lucide-react";

export function ProviderLogo({ provider }: { provider: string }) {
  if (provider === "m365") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="0" y="0" width="7.5" height="7.5" fill="#f25022" />
          <rect x="8.5" y="0" width="7.5" height="7.5" fill="#7fba00" />
          <rect x="0" y="8.5" width="7.5" height="7.5" fill="#00a4ef" />
          <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#ffb900" />
        </svg>
      </span>
    );
  }
  if (provider === "google") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <path d="M8 3.2a4.8 4.8 0 0 1 3.2 1.2l2.2-2.2A8 8 0 0 0 .9 4.5l2.6 2A4.8 4.8 0 0 1 8 3.2Z" fill="#ea4335" />
          <path d="M3.2 8c0-.5.1-1 .3-1.5l-2.6-2a8 8 0 0 0 0 7l2.6-2A4.8 4.8 0 0 1 3.2 8Z" fill="#fbbc05" />
          <path d="M8 12.8a4.8 4.8 0 0 1-4.5-3.3l-2.6 2A8 8 0 0 0 8 16a7.7 7.7 0 0 0 5.3-1.9l-2.5-2a4.8 4.8 0 0 1-2.8.7Z" fill="#34a853" />
          <path d="M15.8 6.5H8v3.2h4.5a3.9 3.9 0 0 1-1.7 2.4l2.5 2A7.8 7.8 0 0 0 16 8a7 7 0 0 0-.2-1.5Z" fill="#4285f4" />
        </svg>
      </span>
    );
  }
  if (provider === "slack") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect x="0.5" y="4.5" width="7" height="3" rx="1.5" fill="#36c5f0" />
          <rect x="4.5" y="0.5" width="3" height="3" rx="1.5" fill="#36c5f0" />
          <rect x="8.5" y="0.5" width="3" height="7" rx="1.5" fill="#2eb67d" />
          <rect x="12.5" y="4.5" width="3" height="3" rx="1.5" fill="#2eb67d" />
          <rect x="8.5" y="8.5" width="7" height="3" rx="1.5" fill="#ecb22e" />
          <rect x="8.5" y="12.5" width="3" height="3" rx="1.5" fill="#ecb22e" />
          <rect x="4.5" y="8.5" width="3" height="7" rx="1.5" fill="#e01e5a" />
          <rect x="0.5" y="8.5" width="3" height="3" rx="1.5" fill="#e01e5a" />
        </svg>
      </span>
    );
  }
  if (provider === "duo") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="18" height="10" viewBox="0 0 18 10">
          <path d="M0 0h2.6a5 5 0 0 1 0 10H0Z" fill="#6bbf4e" />
          <path d="M6.2 0h5v5a2.5 2.5 0 0 1-5 0Z" fill="#6bbf4e" />
          <circle cx="15.4" cy="5" r="2.6" fill="#6bbf4e" />
        </svg>
      </span>
    );
  }
  if (provider === "okta") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="5.6" fill="none" stroke="#1662dd" strokeWidth="3.2" />
        </svg>
      </span>
    );
  }
  if (provider === "sms_code") {
    return (
      <span className="provider-logo provider-logo-tone" style={{ color: "var(--tone-green-fg)" }} aria-hidden="true">
        <MessageSquareText className="icon-sm" />
      </span>
    );
  }
  const tone = (
    {
      ninjaone: [MonitorCog, "blue"],
      itglue: [NotebookText, "violet"],
      hudu: [NotebookText, "teal"],
      rest: [Braces, "neutral"],
      connectwise: [Headset, "red"],
      autotask: [Headset, "blue"],
      halopsa: [Headset, "green"],
    } as const
  )[provider as "ninjaone" | "itglue" | "hudu" | "rest" | "connectwise" | "autotask" | "halopsa"];
  if (tone) {
    const [Icon, color] = tone;
    return (
      <span className="provider-logo provider-logo-tone" style={{ color: `var(--tone-${color}-fg)` }} aria-hidden="true">
        <Icon className="icon-sm" />
      </span>
    );
  }
  if (provider === "syncro") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <rect width="16" height="16" rx="4" fill="#1b7fe3" />
          <path d="M4.2 9.2A4 4 0 0 1 11.3 5" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M11.8 6.8A4 4 0 0 1 4.7 11" fill="none" stroke="#9fe0ff" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M11.9 2.9v2.6H9.3" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.1 13.1v-2.6h2.6" fill="none" stroke="#9fe0ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (provider === "dynamics") {
    return (
      <span className="provider-logo" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16">
          <defs>
            <linearGradient id="dyn-a" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#0b53ce" />
              <stop offset="1" stopColor="#7252aa" />
            </linearGradient>
          </defs>
          <path d="M3 1l10 4.4v5.2L3 15Z" fill="url(#dyn-a)" />
          <path d="M3 1l5 3.2v7.6L3 15Z" fill="#fff" fillOpacity=".28" />
        </svg>
      </span>
    );
  }
  return <span className="provider-logo" aria-hidden="true" />;
}
