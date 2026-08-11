import { createRequire } from "node:module";

// @kenjiuno/msgreader's compiled CJS output does its own `exports.default =`
// interop, which Node's ESM loader double-wraps — `import MsgReader from
// "@kenjiuno/msgreader"` silently resolves to an object, not the class, so
// `new MsgReader(...)` throws "MsgReader is not a constructor". Loading it
// through a real CJS require sidesteps that extra wrapping. Verified this
// also works from inside a Piscina worker thread (tsx/esm loader).
const require = createRequire(import.meta.url);
const MsgReader = require("@kenjiuno/msgreader").default as new (data: ArrayBuffer | DataView) => {
  getFileData(): any;
  getAttachment(attach: number | any): { fileName: string; content: Uint8Array };
};

export default MsgReader;
