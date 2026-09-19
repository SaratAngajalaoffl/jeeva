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
