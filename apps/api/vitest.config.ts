/**
 * Vitest configuration for the Murmur Fastify API workspace.
 *
 * This keeps API tests on the canonical Node runtime and restricts discovery to
 * colocated source test files.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
