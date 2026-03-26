/**
 * Copies runtime JSON assets required by the built API bundle.
 *
 * The TypeScript compiler emits JavaScript only, so configuration assets such
 * as the moderation blocklist need to be copied into `dist/` explicitly after
 * compilation.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_BLOCKLIST_URL = new URL("../src/config/blocklist.json", import.meta.url);
const DESTINATION_BLOCKLIST_URL = new URL("../dist/config/blocklist.json", import.meta.url);

/**
 * Ensures the parent directory for a target file exists before copying.
 *
 * @param filePath - Absolute path of the target file being written.
 */
function ensureParentDirectory(filePath) {
  const parentDirectory = dirname(filePath);

  if (!existsSync(parentDirectory)) {
    mkdirSync(parentDirectory, {
      recursive: true,
    });
  }
}

/**
 * Copies the moderation blocklist into the built API output directory.
 */
function copyAssets() {
  const sourcePath = fileURLToPath(SOURCE_BLOCKLIST_URL);
  const destinationPath = fileURLToPath(DESTINATION_BLOCKLIST_URL);

  ensureParentDirectory(destinationPath);
  copyFileSync(sourcePath, destinationPath);
}

copyAssets();
