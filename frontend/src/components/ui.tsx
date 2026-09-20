import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-xl border border-surface-1 bg-surface-0/60 p-6 shadow-lg shadow-black/20 backdrop-blur ${className}`}
      {...props}
    />
  );
}

export function Button({
  className = "",
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-ember text-primary-foreground hover:bg-ember/90",
    ghost:
      "border border-surface-1 bg-transparent text-text hover:border-ember/60 hover:text-ember",
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rounded-lg border border-surface-1 bg-mantle px-3 py-2 text-sm text-text placeholder:text-overlay-1 outline-none focus:border-ember/70 focus:ring-1 focus:ring-ember/50 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`rounded-lg border border-surface-1 bg-mantle px-3 py-2 text-sm text-text outline-none focus:border-ember/70 focus:ring-1 focus:ring-ember/50 ${className}`}
      {...props}
    />
  );
}

export function Label({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`text-sm text-subtext-1 ${className}`} {...props} />;
}

export function IconButton({
  className = "",
  active = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "border-peach/60 bg-peach/15 text-peach"
          : "border-surface-1 bg-transparent text-subtext-1 hover:border-ember/40 hover:text-text"
      } ${className}`}
      {...props}
    />
  );
}

export function StatTile({
  label,
  value,
  tone = "default",
  icon,
  hint,
  footer,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "positive" | "negative";
  /** Small glyph beside the label. */
  icon?: React.ReactNode;
  /** One line of context under the value — a split, a rate, a period. */
  hint?: React.ReactNode;
  /** Anything that needs the full width, e.g. a meter. */
  footer?: React.ReactNode;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-400"
      : tone === "negative"
        ? "text-destructive"
        : "text-text";
  return (
    <Card className="flex flex-col gap-1 p-5">
      <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-subtext-0">
        {icon}
        {label}
      </span>
      <span className={`text-2xl font-semibold tracking-tight ${toneClass}`}>
        {value}
      </span>
      {hint && <span className="text-xs text-subtext-1">{hint}</span>}
      {footer && <div className="mt-2">{footer}</div>}
    </Card>
  );
}

/**
 * A titled panel for a chart or a list. Keeps every card on a page to one
 * header shape: title on the left, an optional link or note on the right,
 * an optional subtitle naming the unit or the window.
 */
export function ChartCard({
  title,
  subtitle,
  action,
  className = "",
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={`flex flex-col gap-4 p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-medium text-text">{title}</h3>
          {subtitle && (
            <p className="text-xs text-subtext-0">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** Small state pill: a dot plus a word, never colour on its own. */
export function StatusPill({
  tone,
  children,
  title,
}: {
  tone: "good" | "warning" | "critical" | "muted";
  children: React.ReactNode;
  title?: string;
}) {
  const styles = {
    good: "border-emerald-400/40 bg-emerald-400/10 text-emerald-400",
    warning: "border-peach/40 bg-peach/10 text-peach",
    critical: "border-destructive/40 bg-destructive/10 text-destructive",
    muted: "border-surface-1 bg-surface-0 text-subtext-0",
  }[tone];
  const dot = {
    good: "bg-emerald-400",
    warning: "bg-peach",
    critical: "bg-destructive",
    muted: "bg-overlay-0",
  }[tone];

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${styles}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-md bg-surface-1 ${className}`}
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-surface-2/60 to-transparent" />
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <Card className="flex flex-col gap-2 p-5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-16" />
    </Card>
  );
}

export function PageHeading({
  title,
  action,
}: {
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
      {action}
    </div>
  );
}
