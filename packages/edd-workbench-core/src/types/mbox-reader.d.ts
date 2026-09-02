// mbox-reader ships no type declarations of its own and no
// @types/mbox-reader package exists — this covers only the one export
// mbox.ts actually uses, confirmed against the real source
// (node_modules/mbox-reader/lib/mbox-reader.js). Pulled into every
// consuming tsconfig's program via mbox.ts's own triple-slash reference
// directive, not via this package's own "include" glob — a plain ambient
// declaration file like this one is only visible to a given tsconfig
// program if something in that program's file graph actually references
// it; it is not automatically picked up by a *different* package's
// tsconfig (e.g. the worker's own typecheck, which pulls this module in
// transitively through the barrel export but has an `include` rooted at
// its own src/, not this package's).
declare module "mbox-reader" {
  export interface MboxMessage {
    returnPath: string | null;
    time: Date | false;
    content: Buffer;
    headers: Map<string, string[]>;
    flags: string[];
    labels: string[];
    readSize: number;
  }

  export function mboxReader(
    sourceStream: NodeJS.ReadableStream,
    options?: { gz?: boolean },
  ): AsyncGenerator<MboxMessage>;
}
