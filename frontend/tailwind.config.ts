import type { Config } from "tailwindcss";

// Design language: "civic blueprint" — the dashboard reads like an
// architectural site-plan / surveying sheet, not a generic SaaS panel.
// See docs/ARCHITECTURE.md is for backend; this token set is the visual
// system referenced across every frontend component.
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        blueprint: {
          950: "#081A2E", // deepest background
          900: "#0F2A47", // base background
          800: "#163B60", // panel
          700: "#1D4E76", // panel hover / raised
          600: "#2A628E",
          line: "#8FD9E8", // hairline / gridline cyan — the recurring linework color
        },
        signal: {
          amber: "#F2A65A", // high priority / alerts
          red: "#E2694F",   // critical
          green: "#6FBF8B", // resolved / good
        },
        paper: "#EDEEE7",
        // UAE national flag palette, used on the public-facing pages to root
        // the product in its market. Applied as accent colour only — this is
        // a platform for UAE cities, not an official government service, so
        // it deliberately stops short of state emblems or ministry branding.
        uae: {
          red: "#CE1126",
          green: "#00732F",
          black: "#000000",
          white: "#FFFFFF",
          sand: "#D9C9A3",
        },
      },
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        mono: ["var(--font-mono)"],
      },
      // A display scale with tight tracking — Geist is drawn for this, and
      // large headings set at default tracking look loose and dated.
      fontSize: {
        "display-sm": ["2.25rem", { lineHeight: "1.1", letterSpacing: "-0.032em" }],
        "display-md": ["3.25rem", { lineHeight: "1.04", letterSpacing: "-0.036em" }],
        "display-lg": ["4.5rem", { lineHeight: "0.98", letterSpacing: "-0.04em" }],
      },
      transitionTimingFunction: {
        "out-expo": "cubic-bezier(0.16, 1, 0.3, 1)",
        spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
      backgroundImage: {
        "grid-fine": "linear-gradient(rgba(143,217,232,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(143,217,232,0.07) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "24px 24px",
      },
    },
  },
  plugins: [],
};

export default config;
