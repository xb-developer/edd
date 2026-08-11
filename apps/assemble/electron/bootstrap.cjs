// Dev-mode shim: registers tsx's require hook so main.ts can be loaded directly
// without a build step. Kept as .cjs (even though the project is "type": "module")
// because tsx's require-hook only works from CommonJS. Same pattern as XB View's
// and Stratum's own Electron shells.
require("tsx/cjs");
require("./main.ts");
