import { createRequire } from "node:module";

// createRequire resolves relative to this file's location.
// In the compiled output (dist/version.js) '../package.json' points to
// the project root package.json — both locally and when installed via npm.
const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

export const AGENT_VERSION: string = _pkg.version;
