// Loads node-pty in both dev and packaged (Node SEA) builds.
// In a SEA build the app is a single cordless.exe; node-pty (a native module) can't live inside
// the SEA blob, so it ships beside the exe under resources/node_modules and is loaded from there.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const beside = path.join(path.dirname(process.execPath), "resources", "node_modules");

let pty;
if (fs.existsSync(path.join(beside, "node-pty", "package.json"))) {
  // Packaged: resolve node-pty from the resources directory next to the executable.
  pty = createRequire(path.join(beside, "_loader.cjs"))("node-pty");
} else {
  // Dev: resolve from the normal node_modules tree.
  pty = createRequire(import.meta.url)("node-pty");
}

export default pty;
