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
  return <span className="provider-logo" aria-hidden="true" />;
}
