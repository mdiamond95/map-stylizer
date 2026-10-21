// Opens the first page of a PDF scan as an image. pdf.js is loaded only when
// a PDF is picked, using its legacy build so older iPad Safari can run it.

// Scans are usually 300 dpi; iPad Safari can't make a canvas over about
// 16.7 million pixels, so very large pages are drawn smaller.
const DPI = 300, MAX_PIXELS = 16e6;

export async function pdfToImage(file) {
  const [pdfjs, { default: workerUrl }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    canvas.width = canvas.height = 0;
    return { dataUrl, width: Math.floor(viewport.width), height: Math.floor(viewport.height), pages: doc.numPages };
  } finally {
    task.destroy();
  }
}
