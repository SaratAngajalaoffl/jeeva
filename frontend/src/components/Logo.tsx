interface LogoProps {
  className?: string;
  height?: number;
}

export default function Logo({ className, height = 28 }: LogoProps) {
  return (
    <svg
      role="img"
      aria-label="Jeeva"
      height={height}
      viewBox="0 0 620 210"
      className={className}
    >
      <defs>
        <clipPath id="jeeva-logo-letters">
          <text
            x="0"
            y="188"
            fontFamily="'Arial Black', 'Helvetica Neue', Arial, sans-serif"
            fontWeight={900}
            fontSize={195}
            letterSpacing={-18}
            textLength={610}
            lengthAdjust="spacingAndGlyphs"
          >
            JEEVA
          </text>
        </clipPath>
        <clipPath id="jeeva-logo-top-half">
          <polygon points="0,0 620,0 620,40 0,170" />
        </clipPath>
      </defs>
      <g clipPath="url(#jeeva-logo-letters)">
        <rect x="0" y="0" width="620" height="210" className="fill-ember" />
        <g clipPath="url(#jeeva-logo-top-half)">
          <rect x="0" y="0" width="620" height="210" className="fill-peach" />
        </g>
      </g>
    </svg>
  );
}
