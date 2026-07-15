import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fail packaging unless the built web client is present in public/ — otherwise `npm publish` would
// silently ship a daemon with no UI to serve. Run `npm run build:public` to produce it.
const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, "..", "public");

const errs = [];
if (!fs.existsSync(path.join(pub, "index.html"))) errs.push("public/index.html is missing");
const assetsDir = path.join(pub, "assets");
const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
if (!assets.some((f) => /^index-.*\.js$/.test(f))) errs.push("public/assets/index-*.js (the built web client) is missing");

if (errs.length) {
  console.error("verify-package FAILED:");
  for (const e of errs) console.error("  - " + e);
  console.error("  Run `npm run build:public` first (builds the web client into agent/public).");
  process.exit(1);
}
console.log("verify-package OK — web client present in public/ (" + assets.length + " asset file(s)).");
