// Build a self-contained cordless.exe (Node SEA) with node-pty shipped beside it in resources/.
// Usage: node build/sea.mjs   (run with the exact Node version you want to embed)
//
// Output: agent/dist-sea/
//   cordless.exe                      (Node runtime + injected app blob)
//   resources/node_modules/node-pty/  (native module + ABI-stable prebuilds)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(AGENT, "dist-sea");
const RES = path.join(OUT, "resources");
const NODE = process.execPath;
const isWin = process.platform === "win32";
const exeName = isWin ? "cordless.exe" : "cordless";
const exe = path.join(OUT, exeName);

console.log("* cleaning", OUT);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(RES, { recursive: true });

console.log("* bundling app (esbuild, node-pty external)");
await build({
  entryPoints: [path.join(AGENT, "src", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: path.join(OUT, "bundle.cjs"),
  external: ["node-pty"],
  legalComments: "none",
});

console.log("* generating SEA blob");
const cfg = {
  main: path.join(OUT, "bundle.cjs"),
  output: path.join(OUT, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(OUT, "sea-config.json"), JSON.stringify(cfg));
execFileSync(NODE, ["--experimental-sea-config", path.join(OUT, "sea-config.json")], { stdio: "inherit" });

console.log("* copying node runtime ->", exeName);
fs.copyFileSync(NODE, exe);

// macOS refuses to run a modified signed binary; strip the signature before injecting.
if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}

console.log("* injecting blob (postject)");
const postjectCli = path.join(AGENT, "node_modules", "postject", "dist", "cli.js");
const args = [postjectCli, exe, "NODE_SEA_BLOB", path.join(OUT, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
execFileSync(NODE, args, { stdio: "inherit" });

// Re-sign ad-hoc on macOS so Gatekeeper at least runs it locally (real signing is a release step).
if (process.platform === "darwin") {
  try {
    execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}

console.log("* staging node-pty into resources/node_modules");
const ptySrc = path.join(AGENT, "node_modules", "node-pty");
const ptyDst = path.join(RES, "node_modules", "node-pty");
fs.cpSync(ptySrc, ptyDst, { recursive: true });

console.log("* staging web client into resources/public");
const pubSrc = path.join(AGENT, "public");
if (fs.existsSync(path.join(pubSrc, "index.html"))) {
  fs.cpSync(pubSrc, path.join(RES, "public"), { recursive: true });
} else {
  console.warn("  ! agent/public is empty — run `npm --prefix client run build` first so the daemon can serve the PWA");
}

// Trim node-pty prebuilds to the current platform/arch to keep the payload small.
const keep = `${process.platform}-${process.arch}`;
const prebuilds = path.join(ptyDst, "prebuilds");
if (fs.existsSync(prebuilds)) {
  for (const d of fs.readdirSync(prebuilds)) {
    if (d !== keep) fs.rmSync(path.join(prebuilds, d), { recursive: true, force: true });
  }
}

fs.rmSync(path.join(OUT, "sea-prep.blob"), { force: true });
fs.rmSync(path.join(OUT, "bundle.cjs"), { force: true });
fs.rmSync(path.join(OUT, "sea-config.json"), { force: true });
const mb = (fs.statSync(exe).size / 1e6).toFixed(1);
console.log(`\nbuilt ${exe} (${mb} MB) + resources/  (node-pty + web client)`);
console.log("  test:  " + (isWin ? "dist-sea\\cordless.exe --once" : "dist-sea/cordless --once"));
