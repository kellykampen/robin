#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const entry = path.join(__dirname, "..", "lib", "local-cli.js");
if (!fs.existsSync(entry)) {
  console.error("Robin CLI is not built. Run npm ci && npm run build:cli in the Robin clone.");
  process.exitCode = 2;
} else {
  require(entry);
}
