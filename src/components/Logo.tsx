// The app's logo (public/logo.png; the favicon and app icons in src/app are made from the same image).
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      {/* eslint-disable-next-line @next/next/no-img-element -- a small static file, no optimisation needed */}
      <img src="/logo.png" width={26} height={26} alt="" aria-hidden className="h-[26px] w-[26px] shrink-0" />
      {!compact && (
        <span className="text-[15px] font-semibold tracking-tight text-gray-900">
          LM <span className="text-brand-600">Data Universe</span>
        </span>
      )}
    </span>
  );
}
