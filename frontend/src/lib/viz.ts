/**
 * Chart tokens for the Ember dark theme.
 *
 * Every colour here was picked against the dashboard's card surface
 * (`#241518` at 60% over base `#150d0f` ≈ `#1d1114`) and validated for
 * colour-vision-deficiency separation rather than eyeballed. The numbers
 * quoted below are OKLab ΔE ×100 under Machado-Oliveira-Fernandes at
 * severity 1.0 (protanopia/deuteranopia), plus the unsimulated
 * "normal vision" distance.
 *
 * Two families, deliberately kept apart:
 *
 * - `SERIES` encodes *identity* (which market). Warm red and green are
 *   excluded from it on purpose — in a trading UI those two hues already
 *   mean "losing" and "winning", so spending them on series identity
 *   makes a chart ambiguous. Validated all-pairs (any two lines can end
 *   up neighbours in a multi-line chart): worst pair ΔE 9.0 CVD / 18.5
 *   normal, all four inside the dark lightness band at ≥ 3:1 contrast.
 *
 * - `DIRECTION_FILL` encodes *polarity* (long / flat / short) — a
 *   diverging scale, so it is two opposed hues around a neutral. Stack
 *   and slice order is always long → flat → short so the green and the
 *   red never touch (adjacent worst ΔE 10.1 CVD / 19.9 normal; the bare
 *   green↔red pair sits at 6.0 and is only legal with the labels and 2px
 *   surface gaps this dashboard always ships).
 *
 * `NEUTRAL` is intentionally below the chroma floor: it is the diverging
 * midpoint and the "Other" bucket, and its job is to read as absent.
 *
 * Text keeps the brighter Tailwind tokens (`text-emerald-400`,
 * `text-destructive`) — those are judged on WCAG text contrast (10.6:1
 * and 6.6:1 here), not on the mark palette's lightness band.
 */

/** Categorical slots for per-market series. Assigned by identity, never by rank. */
export const SERIES = ["#30a1d3", "#a17431", "#79539f", "#d965a2"] as const;

/** De-emphasis / "Other" / diverging midpoint. */
export const NEUTRAL = "#7b5a5d";

/** Diverging fills for target direction and position side. */
export const DIRECTION_FILL = {
  long: "#349b5a",
  flat: NEUTRAL,
  short: "#e66060",
} as const;

/** Order stacks and slices with the neutral between the poles. */
export const DIRECTION_ORDER = ["long", "flat", "short"] as const;

/** Reserved status steps — always shipped with an icon or a label, never colour alone. */
export const STATUS = {
  good: "#349b5a",
  warning: "#c98500",
  critical: "#e66060",
} as const;

/** Shared chart chrome. */
export const CHART = {
  surface: "#1d1114",
  tooltipBg: "#150d0f",
  tooltipBorder: "#452127",
  grid: "#33191d",
  mutedText: "#c29a9d",
  primaryText: "#f6e9ea",
  accent: "#ff3b3b",
} as const;

export const TOOLTIP_STYLE = {
  background: CHART.tooltipBg,
  border: `1px solid ${CHART.tooltipBorder}`,
  borderRadius: 8,
  color: CHART.primaryText,
  fontSize: 12,
} as const;

/**
 * A market's colour slot. Assignment is by the symbol's position in a
 * caller-supplied stable list (alphabetical), so a market keeps its hue
 * when the time range changes and other markets come and go.
 */
export function seriesColor(index: number): string {
  return index < SERIES.length ? SERIES[index] : NEUTRAL;
}
