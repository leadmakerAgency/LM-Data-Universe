export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect x="2" y="2" width="28" height="28" rx="8" fill="#5a43d9" />
        <rect x="8" y="9" width="7" height="5" rx="1.5" fill="#fff" />
        <rect x="17" y="9" width="7" height="5" rx="1.5" fill="#c9c3fb" />
        <rect x="8" y="16" width="7" height="5" rx="1.5" fill="#c9c3fb" />
        <rect x="17" y="16" width="7" height="5" rx="1.5" fill="#fff" />
        <circle cx="24" cy="24" r="3" fill="#a5f3fc" />
      </svg>
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-gray-900">
          LM <span className="text-brand-600">Data Universe</span>
        </span>
      )}
    </span>
  );
}
