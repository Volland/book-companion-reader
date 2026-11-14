import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] || "production";
const here = path.dirname(fileURLToPath(import.meta.url));

if (mode === "production" || mode === "dev") {
  await esbuild.build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
    format: "cjs",
    target: "es2020",
    platform: "browser",
    sourcemap: mode === "dev" ? "inline" : false,
    minify: mode === "production",
    treeShaking: true,
    logLevel: "info",
    outfile: "main.js",
  });
}

if (mode === "test") {
  // Self-test runs the real plugin modules in Node with a stand-in for Obsidian.
  await esbuild.build({
    entryPoints: ["test/selftest.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    alias: { obsidian: path.join(here, "test/obsidian-mock.ts") },
    outfile: "test/out/selftest.js",
    logLevel: "warning",
  });
}

if (mode === "preview") {
  // Browser preview: the real reader view with a stand-in Obsidian and a sample book.
  await esbuild.build({
    entryPoints: ["preview/preview.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2020",
    alias: { obsidian: path.join(here, "test/obsidian-mock.ts") },
    outfile: "preview/preview.js",
    logLevel: "warning",
  });
}

if (mode === "pdf-preview") {
  await esbuild.build({
    entryPoints: ["preview/pdf-preview.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    alias: { obsidian: path.join(here, "test/obsidian-mock.ts") },
    outfile: "preview/pdf-preview.js",
    logLevel: "warning",
  });
}
