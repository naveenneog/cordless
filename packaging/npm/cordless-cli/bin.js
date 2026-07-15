#!/usr/bin/env node
// cordless-cli is a thin alias for @naveenneog/cordless: installing it pulls in the real package and
// exposes the `cordless` command. This just hands off to the real entry point; process.argv is
// preserved, so `npx cordless-cli <args>` behaves exactly like `cordless <args>`.
import "@naveenneog/cordless/src/index.js";
