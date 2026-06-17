import nextConfig from "eslint-config-next";

const eslintConfig = [
  {
    ignores: ["playwright-report/**", "test-results/**", ".next/**"]
  },
  ...nextConfig,
  {
    files: ["src/components/ContextInspector.tsx", "src/components/TraceTimeline.tsx"],
    rules: {
      "react-hooks/incompatible-library": "off"
    }
  },
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off"
    }
  }
];

export default eslintConfig;
