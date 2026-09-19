import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        text: "#f6e9ea",
        "subtext-1": "#d9b8bb",
        "subtext-0": "#c29a9d",
        "overlay-2": "#a97c80",
        "overlay-1": "#8a5b60",
        "overlay-0": "#6e4448",
        "surface-2": "#452127",
        "surface-1": "#33191d",
        "surface-0": "#241518",
        base: "#150d0f",
        mantle: "#0f0a0b",
        crust: "#0a0607",
        ember: "#ff3b3b",
        peach: "#ff9f5a",
        background: "#150d0f",
        foreground: "#f6e9ea",
        muted: "#241518",
        "muted-foreground": "#d9b8bb",
        primary: "#ff3b3b",
        "primary-foreground": "#150d0f",
        secondary: "#ff9f5a",
        "secondary-foreground": "#150d0f",
        border: "#33191d",
        ring: "#ff3b3b",
        destructive: "#ff6b6b",
      },
      fontFamily: {
        sans: ["var(--font-montserrat)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
