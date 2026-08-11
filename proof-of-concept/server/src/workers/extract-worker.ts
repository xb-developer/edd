import { extractMetadata, type ExtractedMetadata } from "../lib/metadata.js";

export interface ExtractTask {
  filePath: string;
  extension: string;
}

// Runs inside a Piscina worker thread — pure CPU-bound extraction (mammoth,
// SheetJS, officeparser, word-extractor, Tesseract OCR), no DB access. This
// is what actually gets the benefit of running on more than one core.
export default function extractTask(task: ExtractTask): Promise<ExtractedMetadata> {
  return extractMetadata(task.filePath, task.extension);
}
