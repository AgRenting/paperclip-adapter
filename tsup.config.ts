import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["server/src/index.ts"],
    outDir: "dist/server",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
  },
  {
    entry: ["ui/src/index.ts"],
    outDir: "dist/ui",
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: false,
    target: "es2022",
    external: ["react", "react-dom"],
  },
]);
