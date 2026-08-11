/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    // Present only when running inside the Electron shell (see electron/preload.cjs).
    assemble?: {
      pickFiles: () => Promise<string[] | null>;
      pickBundleFile: () => Promise<string | null>;
      pickFolder: () => Promise<string | null>;
    };
  }
}
