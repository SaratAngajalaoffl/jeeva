export function SamplingIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" {...props}>
      <circle cx="10" cy="10" r="1.6" fill="currentColor" />
      <path
        d="M6.3 13.7a5.2 5.2 0 0 1 0-7.4M13.7 6.3a5.2 5.2 0 0 1 0 7.4M4 16a9 9 0 0 1 0-12M16 4a9 9 0 0 1 0 12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function TradingIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M11 2 4 11.5h4.5L9 18l7-9.5h-4.5L11 2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ViewIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" {...props}>
      <path
        d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
