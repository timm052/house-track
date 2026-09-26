// In-app viewer for a house's documents and photos: PDFs drawn with pdf.js (every page, on phones too, where the
// built-in viewer often shows only the first), images full size. Opens over the page; arrows step through the
// house's other files. Loaded lazily, so pdf.js only downloads when a document is opened.
import { ChevronLeft, ChevronRight, Download, ExternalLink, Minus, Plus, X } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type ViewerItem = { id: string; title: string; mime: string | null };

export default function DocViewer({ items, start, onClose }: { items: ViewerItem[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const item = items[index];
  const src = `/api/attachments/${item.id}/file`;
  const isPdf = item.mime === "application/pdf";
  const isImage = !!item.mime?.startsWith("image/");
  const [zoom, setZoom] = useState(1);
  const go = (d: number) => { setIndex((i) => (i + d + items.length) % items.length); setZoom(1); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && items.length > 1) go(1);
      if (e.key === "ArrowLeft" && items.length > 1) go(-1);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={item.title}>
      <div className="viewer-bar">
        <strong className="grow viewer-title">{item.title}</strong>
        {items.length > 1 && <span className="small viewer-count">{index + 1} of {items.length}</span>}
        {(isPdf || isImage) && <>
          <button aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}><Minus /></button>
          <button aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}><Plus /></button>
        </>}
        <a className="viewer-btn" href={src} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab"><ExternalLink /></a>
        <a className="viewer-btn" href={src} download aria-label="Download" title="Download"><Download /></a>
        <button aria-label="Close" onClick={onClose}><X /></button>
      </div>
      <div className="viewer-body" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {isPdf ? <PdfPages src={src} zoom={zoom} key={src} />
          : isImage ? <img className="viewer-image" src={src} alt={item.title} style={{ width: `${zoom * 100}%`, maxWidth: zoom === 1 ? "100%" : "none" }} />
          : (
            <div className="viewer-other">
              <p>This kind of file can't be shown here.</p>
              <a href={src} download><button className="primary"><Download /> Download it</button></a>
            </div>
          )}
      </div>
      {items.length > 1 && <>
        <button className="viewer-nav prev" aria-label="Previous" onClick={() => go(-1)}><ChevronLeft /></button>
        <button className="viewer-nav next" aria-label="Next" onClick={() => go(1)}><ChevronRight /></button>
      </>}
    </div>
  );
}

/** Every page of a PDF, drawn to fit the viewer's width (times the zoom), sharp on high-density screens. */
function PdfPages({ src, zoom }: { src: string; zoom: number }) {
  const holder = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    // Fetched whole (rather than by pdf.js's range requests), so the app's cache keeps it for offline.
    fetch(src).then((r) => { if (!r.ok) throw new Error(`Couldn't load the document (${r.status}).`); return r.arrayBuffer(); })
      .then((data) => { task = pdfjs.getDocument({ data }); return task.promise; })
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof TypeError ? "You're offline and this document isn't saved on this device." : (e as Error).message); });
    return () => { cancelled = true; void (task as ReturnType<typeof pdfjs.getDocument> | null)?.destroy(); };
  }, [src]);

  useEffect(() => {
    const el = holder.current;
    if (!doc || !el) return;
    let cancelled = false;
    el.replaceChildren();
    const width = Math.min(el.clientWidth - 16, 1100) * zoom;
    (async () => {
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: width / base.width });
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.className = "viewer-page";
        canvas.setAttribute("aria-label", `Page ${n} of ${doc.numPages}`);
        if (cancelled) return;
        el.appendChild(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
      }
    })().catch((e) => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [doc, zoom]);

  return (
    <>
      {!doc && !error && <p className="viewer-loading">Opening…</p>}
      {error && <p className="viewer-loading">{error}</p>}
      <div ref={holder} className="viewer-pages" />
    </>
  );
}
