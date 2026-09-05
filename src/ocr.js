// OCR fallback for scanned/photographed documents across PO Upload,
// Material Inward, and Invoices' upload-and-scan flows. Only invoked when
// the fast, free path (extractPdfText) finds nothing — a PDF with no
// embedded text layer (a scan or a photo saved as PDF) or a plain image
// file. OCR is slow (several seconds — first run in a browser also pays a
// one-time cost to fetch the ~2-4MB WASM engine + language data, cached by
// tesseract.js afterwards) and imperfect, so it's strictly a fallback:
// every field it fills stays fully editable, same as the regex-based
// parsers in pdfParser.js, and it never throws — a failure here just means
// falling back to today's "enter it by hand" messaging.
//
// Uses tesseract.js's default CDN-hosted engine/language data (jsdelivr) —
// the standard, widely-used way to run it in a browser; no local asset
// bundling needed, matching how a plain <script src="cdn..."> would work
// but through the npm package instead.
import { createWorker } from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist';

/**
 * Renders a PDF's first page to an off-DOM canvas at a higher-than-1x
 * scale — real document text is too small at a PDF's native 72dpi for
 * reliable OCR, so this renders larger before handing it to Tesseract.
 * @param {File} file
 * @param {number} scale
 */
async function renderFirstPdfPageToCanvas(file, scale = 2.5) {
  const buffer = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

/**
 * OCRs a File — a scanned image directly, or the first page of a PDF with
 * no extractable text layer (render it to a canvas first, since Tesseract
 * reads images/canvases, not PDF bytes). Returns '' rather than throwing
 * if OCR itself isn't usable (e.g. a corrupt file, or the OCR engine
 * failing to load), so callers can fall back to their existing "enter by
 * hand" messaging exactly as if OCR had never been attempted.
 * @param {File} file
 * @param {(progress: number) => void} [onProgress] 0-1, only reported
 *   during the actual recognition pass (not the slower initial engine/
 *   language download on a browser's first-ever OCR call).
 * @returns {Promise<string>}
 */
export async function ocrFile(file, onProgress) {
  let source;
  try {
    source = file.type === 'application/pdf' ? await renderFirstPdfPageToCanvas(file) : file;
  } catch {
    return '';
  }

  let worker;
  try {
    worker = await createWorker('eng', undefined, {
      logger: (msg) => {
        if (msg.status === 'recognizing text' && typeof msg.progress === 'number') {
          onProgress?.(msg.progress);
        }
      },
    });
    const {
      data: { text },
    } = await worker.recognize(source);
    return text || '';
  } catch {
    return '';
  } finally {
    await worker?.terminate();
  }
}
