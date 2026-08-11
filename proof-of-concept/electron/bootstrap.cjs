// Dev-mode shim: registers tsx's require hook so main.ts can be loaded directly
// without a build step. Kept as .cjs (even though the project is "type": "module")
// because tsx's require-hook only works from CommonJS.
require("tsx/cjs");
require("./main.ts");
