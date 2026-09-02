/// <reference path="../types/mbox-reader.d.ts" />
import { createReadStream } from "node:fs";
import { mboxReader } from "mbox-reader";

/**
 * Streams a real .mbox file's individual messages one at a time — each
 * yielded buffer is already a complete, standalone RFC822 message, the
 * exact same shape ingest.ts's own `eml` branch already expects. See
 * ingest.ts's handleMboxIngest, which writes each yielded buffer to S3
 * as-is and lets it re-enter that branch via the queue, rather than
 * duplicating eml.ts's own parsing here — zero new parsing logic for the
 * actual message content, only for splitting the mailbox apart.
 *
 * mbox-reader is a genuine streaming parser (explicitly documented to
 * support multi-GB mbox files without buffering them fully) — necessary
 * given the worker task's 1024 MiB memory limit; a naive whole-file-in-
 * memory splitter is not an option here. Takes a file path (not a Buffer)
 * for the same disk-streaming reason pst.ts's iteratePstMessages does.
 *
 * Only the mboxrd convention (the most common real-world variant, where a
 * body line starting with "From " is escaped as ">From " to avoid
 * ambiguity with a real message boundary, and unescaped back on read) is
 * supported. mbox-reader does not parse the Content-Length-delimited
 * `mboxcl2` variant some Thunderbird/Dovecot exports use — flagged here as
 * a known gap, not silently unconsidered, matching contentType.ts's own
 * precedent for documenting a real format-support gap rather than masking
 * it.
 */
export async function* iterateMboxMessages(filePath: string): AsyncGenerator<Buffer> {
  for await (const message of mboxReader(createReadStream(filePath))) {
    yield message.content;
  }
}
