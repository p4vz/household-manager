/**
 * Stamps each build with a version so installed phone apps can tell when a
 * newer deploy is live (src/components/pwa/app-version.ts). Writes
 * public/version.json, which next.config.ts also reads into
 * HM_APP_VERSION. The file holds only this id and the build time.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || "";
const builtAt = new Date().toISOString();
const version = sha ? sha.slice(0, 7) : builtAt.replace(/\D/g, "").slice(0, 14);

writeFileSync(resolve(import.meta.dirname, "../public/version.json"), `${JSON.stringify({ version, builtAt })}\n`);
console.log(`App version ${version}`);
