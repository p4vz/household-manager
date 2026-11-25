/**
 * Copies the in-browser OCR engine (Tesseract) into public/ocr/ so the
 * screenshot reader loads everything from this origin: no CDN, and the
 * image never leaves the phone. Runs before `next dev` / `next build`.
 * Only the LSTM cores are copied (the default engine), plus English data.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const out = resolve(import.meta.dirname, "../public/ocr");
const tesseract = dirname(require.resolve("tesseract.js/package.json"));
const core = dirname(require.resolve("tesseract.js-core/package.json"));
const eng = dirname(require.resolve("@tesseract.js-data/eng/package.json"));

const files = [
  [join(tesseract, "dist/worker.min.js"), "worker.min.js"],
  ...["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm.js"].map((f) => [join(core, f), `core/${f}`]),
  [join(eng, "4.0.0_best_int/eng.traineddata.gz"), "lang/eng.traineddata.gz"],
];

for (const [from, to] of files) {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(from, join(out, to));
}
console.log(`OCR assets copied to public/ocr (${files.length} files)`);
