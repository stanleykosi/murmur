/**
 * Vitest configuration for the Murmur agent orchestrator workspace.
 *
 * This pins the canonical Node test environment and colocated test-file
 * discovery pattern used by Step 36.
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
