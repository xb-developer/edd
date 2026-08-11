// ppt@0.0.2 (SheetJS) ships no type declarations — used only through the
// narrow PptModule interface in lib/legacyPpt.ts, so an ambient `any` module
// here is sufficient rather than modeling its full (undocumented) API.
declare module "ppt";
