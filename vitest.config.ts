import { defineConfig } from "vitest/config";

// Unit tests sit next to the code. They run in Node; a test that needs browser
// APIs must opt in explicitly (see TESTING.md) rather than silently getting a DOM.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
  },
});
