import Tesseract from "tesseract.js";

// OCR failure is expected sometimes (corrupt image, unreadable scan) and
// should never abort an import — just leave the document without extracted
// text, same as any other unparseable file.
export async function ocrImage(filePath: string): Promise<string | null> {
  try {
    const { data } = await Tesseract.recognize(filePath, "eng");
    const text = data.text?.trim();
    return text || null;
  } catch (err) {
    console.warn(`OCR failed for ${filePath}: ${(err as Error).message}`);
    return null;
  }
}
