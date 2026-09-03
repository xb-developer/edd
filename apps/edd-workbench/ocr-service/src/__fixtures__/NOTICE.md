`scan.png`, `scan.pdf`, and `scan-2page.pdf` are synthetic, hand-generated fixtures (not copied from any third-party source) — plain white images with clear black DejaVu Sans Bold text rendered via Pillow, `scan.pdf`/`scan-2page.pdf` wrapping that same rendering directly as an image-only PDF page (no real embedded text layer), so they exercise `tesseract.ts`'s pdftoppm rasterization path rather than `extractPdfTextLayer`'s real-text-layer extractor. Used by `tesseract.test.ts` and `handlers/ocrQueue.test.ts` to verify OCR output against real, known expected text, run through the real Tesseract engine — not mocked.

Regenerated with:

```python
from PIL import Image, ImageDraw, ImageFont
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

def make_page(text, size=(900, 300)):
    img = Image.new("L", size, color=255)
    draw = ImageDraw.Draw(img)
    draw.text((40, 100), text, font=ImageFont.truetype(FONT_PATH, 48), fill=0)
    return img

single = make_page("OCR REGRESSION TEST 482915")
single.save("scan.png")
single.convert("RGB").save("scan.pdf", "PDF")

page1 = make_page("PAGE ONE ALPHA BRAVO")
page2 = make_page("PAGE TWO CHARLIE DELTA")
page1.convert("RGB").save("scan-2page.pdf", "PDF", save_all=True, append_images=[page2.convert("RGB")])
```
