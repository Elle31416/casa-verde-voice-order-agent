export function LogoMark({ className = 'size-9' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="url(#casa-logo-grad)" />
      <path
        d="M23.2 6.6c1.7 9.1-3.8 17-13.7 17.3-.7-9.3 4.7-15.8 13.7-17.3Z"
        fill="oklch(0.95 0.03 155)"
      />
      <path
        d="M9.8 23.4c2.6-6.4 6-10.3 10.9-13.1"
        stroke="oklch(0.3 0.08 157)"
        strokeWidth="1.9"
        strokeLinecap="round"
        fill="none"
      />
      <defs>
        <linearGradient
          id="casa-logo-grad"
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="oklch(0.735 0.155 156)" />
          <stop offset="0.55" stopColor="oklch(0.555 0.13 157)" />
          <stop offset="1" stopColor="oklch(0.87 0.19 120)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark className={compact ? 'size-8' : 'size-9'} />
      <span className="leading-none">
        <span className="block text-[15px] font-bold tracking-tight text-ink">
          Casa Verde
        </span>
        {!compact && (
          <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-[0.22em] text-verde-400">
            Voice Order Agent
          </span>
        )}
      </span>
    </span>
  );
}
