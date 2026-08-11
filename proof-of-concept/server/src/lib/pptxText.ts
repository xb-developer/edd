import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({ ignoreAttributes: false, textNodeName: "#text" });

export interface SlideText {
  index: number;
  text: string;
}

export async function extractPptxSlides(filePath: string): Promise<SlideText[]> {
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);
  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
      return na - nb;
    });

  const slides: SlideText[] = [];
  for (const file of slideFiles) {
    const xml = await zip.file(file)!.async("text");
    const parsed = xmlParser.parse(xml);
    const texts: string[] = [];
    collectText(parsed, texts);
    const index = Number(file.match(/slide(\d+)\.xml$/)?.[1] ?? slides.length + 1);
    slides.push({ index, text: texts.join("\n") });
  }
  return slides;
}

function collectText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if ("a:t" in obj) {
      const t = obj["a:t"];
      if (typeof t === "string") out.push(t);
      else if (t && typeof t === "object" && "#text" in (t as Record<string, unknown>)) {
        out.push(String((t as Record<string, unknown>)["#text"]));
      }
    }
    for (const key of Object.keys(obj)) {
      if (key === "a:t") continue;
      collectText(obj[key], out);
    }
  }
}
