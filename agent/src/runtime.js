// Runtime facts that differ between dev (node src/index.js) and a packaged Node SEA build.
import { createRequire } from "node:module";
import path from "node:path";

let _isSea = false;
try {
  // node:sea is a builtin (Node 20+); isSea() is true only inside a single-executable build.
  _isSea = createRequire(process.execPath)("node:sea").isSea();
} catch {
  _isSea = false;
}

export const IS_SEA = _isSea;

// Directory of files shipped beside the executable in a SEA build (resources/), else null.
export function resourcesDir() {
  return IS_SEA ? path.join(path.dirname(process.execPath), "resources") : null;
}
