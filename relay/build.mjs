// Builds the /file page's assets into public/ (not in git): the Uppy bundle, its CSS and the Archivo figures.
// wrangler runs it before every deploy and dry run ([build] in wrangler.toml).
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

await build({ entryPoints: ["web/file.js"], bundle: true, minify: true, format: "iife", target: "es2022", outfile: "public/file.js" });
writeFileSync("public/file.css", ["@uppy/core/css/style.min.css", "@uppy/dashboard/css/style.min.css"]
  .map((p) => readFileSync(new URL(import.meta.resolve(p))).toString()).join("\n"));
mkdirSync("public/fonts", { recursive: true });
for (const w of [500, 600, 700]) {
  copyFileSync(`node_modules/@fontsource/archivo/files/archivo-latin-${w}-normal.woff2`, `public/fonts/archivo-latin-${w}-normal.woff2`);
}
