import { createRequire } from "node:module";

export interface MsgRecipient {
  name?: string;
  email?: string;
  recipType?: string;
}

export interface MsgFileData {
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: MsgRecipient[];
  messageDeliveryTime?: string;
  creationTime?: string;
  body?: string;
  attachments?: unknown[];
}

// @kenjiuno/msgreader's compiled CJS output does its own `exports.default =`
// interop, which Node's ESM loader double-wraps — `import MsgReader from
// "@kenjiuno/msgreader"` silently resolves to an object, not the class, so
// `new MsgReader(...)` throws "MsgReader is not a constructor". Loading it
// through a real CJS require sidesteps that extra wrapping (same fix already
// proven in the sibling desktop app's server/src/lib/msgReader.ts).
const require = createRequire(import.meta.url);
const MsgReader = require("@kenjiuno/msgreader").default as new (data: ArrayBuffer) => {
  getFileData(): MsgFileData;
};

export default MsgReader;
