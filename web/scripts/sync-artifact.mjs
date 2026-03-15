import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..");
const root = resolve(webDir, "..");
const buildDir = resolve(root, "build");
const mainSrc = resolve(buildDir, "main.five");
const fallback = existsSync(buildDir)
  ? readdirSync(buildDir).find((f) => f.endsWith(".five"))
  : null;
const src = existsSync(mainSrc) ? mainSrc : fallback ? resolve(buildDir, fallback) : mainSrc;
const dst = resolve(webDir, "public", "main.five");

if (!existsSync(src)) {
  console.error(`[sync-artifact] missing ${src}. Run \`npm run build\` in 5ive-blackjack first.`);
  process.exit(1);
}

cpSync(src, dst);
console.log(`[sync-artifact] copied ${src} -> ${dst}`);
