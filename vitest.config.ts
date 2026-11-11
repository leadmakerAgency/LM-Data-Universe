import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@engine": fileURLToPath(new URL("./packages/engine/src", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
