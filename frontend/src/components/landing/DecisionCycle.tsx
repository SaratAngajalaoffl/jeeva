import { Reveal } from "./Reveal";

/**
 * The six steps of one PERP's decision tick, as a ring with a comet sweeping
 * it. Each ring node — and the matching step badge — flares as the comet
 * passes, so the list and the diagram read as the same loop.
 *
 * The comet takes CYCLE seconds per lap; a node at angle A lights at
 * (A / 360) * CYCLE.
 */

const CYCLE = 12;
const CENTER = 150;
const RADIUS = 110;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const STEPS = [
  {
    title: "Read the history",
    body: "Up to the last 1,000 samples for that PERP — price, open interest, volume, spread.",
  },
  {
    title: "Read the position",
    body: "Flat, long or short, straight from the configured ExecutionAdapter.",
  },
  {
    title: "Ask Jev",
    body: "One structured Choice question over a compact text summary of the state.",
  },
  {
    title: "Diff target vs. current",
    body: "Open, close, flip — or do nothing at all when the direction is unchanged.",
  },
  {
    title: "Apply the action",
    body: "A simulated fill on the mock wallet, or a signed Hyperliquid order.",
  },
  {
    title: "Log the tick",
    body: "Context, decision, action and any error — every cycle, including the ones that fail.",
  },
];

/** Angle of node `i` in degrees, clockwise from 3 o'clock (SVG's path start). */
function nodeAngle(index: number) {
  return (-90 + index * (360 / STEPS.length) + 360) % 360;
}

function nodePoint(index: number) {
  const radians = (nodeAngle(index) * Math.PI) / 180;
  return {
    x: CENTER + RADIUS * Math.cos(radians),
    y: CENTER + RADIUS * Math.sin(radians),
  };
}

function flareDelay(index: number) {
  return (nodeAngle(index) / 360) * CYCLE;
}

export function DecisionCycle() {
  return (
    <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Reveal from="zoom" className="flex justify-center">
        <svg
          viewBox="0 0 300 300"
          className="h-auto w-full max-w-[380px]"
          role="img"
          aria-label="The six steps of the decision cycle, arranged as a loop"
        >
          <defs>
            <radialGradient id="jv-core" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#ffb84d" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#ff3b3b" stopOpacity="0" />
            </radialGradient>
          </defs>

          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="#33191d"
            strokeWidth="1.5"
          />

          {/* Comet: a short arc rotated around the ring. */}
          <g className="jv-orbit">
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="#ff3b3b"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`54 ${CIRCUMFERENCE - 54}`}
              opacity="0.9"
            />
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="#ffb84d"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`10 ${CIRCUMFERENCE - 10}`}
              opacity="0.35"
              style={{ filter: "blur(4px)" }}
            />
          </g>

          {STEPS.map((step, index) => {
            const point = nodePoint(index);
            return (
              <g key={step.title}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="12"
                  fill="#150d0f"
                  stroke="#33191d"
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="5"
                  fill="#ff3b3b"
                  opacity="0.35"
                  className="jv-flare"
                  style={{ animationDelay: `${flareDelay(index)}s` }}
                />
              </g>
            );
          })}

          {/* Jev at the centre. */}
          <circle
            cx={CENTER}
            cy={CENTER}
            r="52"
            fill="url(#jv-core)"
            className="jv-breathe"
          />
          <rect
            x={CENTER - 16}
            y={CENTER - 16}
            width="32"
            height="32"
            rx="6"
            transform={`rotate(45 ${CENTER} ${CENTER})`}
            fill="none"
            stroke="#ffb84d"
            strokeWidth="1.5"
          />
          <text
            x={CENTER}
            y={CENTER + 4}
            textAnchor="middle"
            fontSize="13"
            fontWeight="700"
            letterSpacing="0.14em"
            fill="#f6e9ea"
          >
            JEV
          </text>
        </svg>
      </Reveal>

      <ol className="flex flex-col gap-1">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <Reveal
              from="right"
              delay={index * 0.07}
              className="flex gap-4 rounded-xl p-3 transition-colors hover:bg-surface-0/40"
            >
              <span
                className="jv-step mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-surface-1 bg-surface-0/60 text-xs font-semibold text-subtext-0"
                style={{ animationDelay: `${flareDelay(index)}s` }}
                aria-hidden
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold tracking-tight text-text">
                  {step.title}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-subtext-1">
                  {step.body}
                </p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </div>
  );
}
