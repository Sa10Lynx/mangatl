import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // No jsdom/happy-dom environment on purpose: per spec 01's approved plan, this suite must
    // have zero real DOM dependency (no `document`, no `chrome.*`). dom-scan.ts / content-script.ts
    // / background.ts are explicitly manual-verification-only and out of scope here.
  },
});
