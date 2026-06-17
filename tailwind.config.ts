import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./src/**/*.{ts,tsx}",
    "./tests/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        yard: {
          ink: "#17211f",
          muted: "#64736f",
          line: "#d8e0dc",
          panel: "#ffffff",
          wash: "#f5f8f6",
          teal: "#087f78",
          tealSoft: "#d9f2ef",
          amber: "#a86605",
          amberSoft: "#fff1c7",
          rose: "#b42348",
          roseSoft: "#ffe4e8",
          blue: "#2f5f9f",
          blueSoft: "#e2ecff"
        }
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif"
        ],
        mono: [
          "JetBrains Mono",
          "SFMono-Regular",
          "Consolas",
          "Liberation Mono",
          "monospace"
        ]
      },
      boxShadow: {
        panel: "0 1px 2px rgba(23, 33, 31, 0.06), 0 14px 40px rgba(23, 33, 31, 0.06)"
      }
    }
  },
  plugins: []
};

export default config;
