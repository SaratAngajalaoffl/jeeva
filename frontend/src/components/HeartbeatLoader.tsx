import Logo from "./Logo";

// One beat of an ECG trace: flat, a small P bump, the QRS spike, a T wave.
const TRACE =
  "M0 32 H58 L66 24 L74 32 H86 L92 40 L101 6 L110 56 L116 32 H128 L140 20 L152 32 H240";

/**
 * Full-area wait for moments with no layout to sketch yet — checking the
 * session, switching routes, entering the dashboard. A pulse runs along a
 * heartbeat trace; "jeeva" is life, and the engine is very much alive.
 * Anything with a known shape loads behind a `Skeleton` instead.
 */
export function HeartbeatLoader({
  label = "Loading",
  fullScreen = false,
}: {
  label?: string;
  /** Fill the viewport rather than the parent. */
  fullScreen?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-6 px-4 ${
        fullScreen ? "min-h-screen" : "min-h-[50vh] flex-1"
      }`}
    >
      <div aria-hidden>
        <Logo height={26} className="jv-heartbeat-logo" />
      </div>
      <div className="relative">
        <div
          aria-hidden
          className="jv-breathe absolute inset-x-6 top-1/2 h-10 -translate-y-1/2 rounded-full bg-ember/20 blur-2xl"
        />
        <svg
          aria-hidden
          viewBox="0 0 240 64"
          fill="none"
          className="relative h-16 w-60 overflow-visible"
        >
          <defs>
            <linearGradient id="jv-heartbeat-stroke" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stopColor="#ffb84d" />
              <stop offset="1" stopColor="#ff3b3b" />
            </linearGradient>
          </defs>
          {/* The resting trace, always visible as a faint guide. */}
          <path
            d={TRACE}
            pathLength={1}
            stroke="#452127"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* A long, soft afterglow trailing the pulse. */}
          <path
            d={TRACE}
            pathLength={1}
            stroke="url(#jv-heartbeat-stroke)"
            strokeOpacity={0.35}
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="jv-heartbeat-trail"
          />
          {/* The pulse itself. */}
          <path
            d={TRACE}
            pathLength={1}
            stroke="url(#jv-heartbeat-stroke)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="jv-heartbeat-pulse"
          />
        </svg>
      </div>
      <p className="flex items-baseline gap-0.5 text-xs font-medium uppercase tracking-[0.2em] text-subtext-0">
        {label}
        <span aria-hidden className="jv-heartbeat-dot">.</span>
        <span aria-hidden className="jv-heartbeat-dot [animation-delay:0.2s]">.</span>
        <span aria-hidden className="jv-heartbeat-dot [animation-delay:0.4s]">.</span>
      </p>
    </div>
  );
}
