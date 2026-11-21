// File previews (FILE-01), loaded on first use: the card thumbnail, text / media previews, the
// inline PDF viewer (display "preview") and the full viewer / image lightbox. pdf.js loads
// from ./pdf on top of this, only when a PDF is shown.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Ic } from "../../icons";
import { safeHref, safeImageSrc } from "../../lib/urls";
import { fileKind, fmtSize, kindIcon, openUrl, previewUrl, type FileKind } from "./kind";
import { openPdf, renderPage } from "./pdf";

const MAX_PAGES = 2000;
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];
const TEXT_LINES = 12;
const TEXT_BYTES = 512 * 1024;

export const zoomIn = (z: number) => ZOOMS.find((s) => s > z + 0.001) ?? ZOOMS[ZOOMS.length - 1];
export const zoomOut = (z: number) => [...ZOOMS].reverse().find((s) => s < z - 0.001) ?? ZOOMS[0];

// ---------- PDF document state ----------

interface PdfState {
  doc?: PDFDocumentProxy;
  /** Height / width of page 1 (placeholders before a page is drawn). */
  ratio: number;
  pages: number;
  error?: boolean;
}

export function usePdf(src: string): PdfState {
  const [s, set] = useState<PdfState>({ ratio: 1.294, pages: 0 });
  useEffect(() => {
    let off = false;
    set({ ratio: 1.294, pages: 0 });
    openPdf(src)
      .then(async (doc) => {
        const p = await doc.getPage(1);
        const v = p.getViewport({ scale: 1 });
        if (!off) set({ doc, ratio: v.height / v.width, pages: Math.min(doc.numPages, MAX_PAGES) });
      })
      .catch(() => !off && set({ ratio: 1.294, pages: 0, error: true }));
    return () => {
      off = true;
    };
  }, [src]);
  return s;
}

/** One page: a sized placeholder until it scrolls near the viewport, then drawn. */
function PdfPage({ doc, n, width, ratio, total, root, text }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number; total: number; root: HTMLElement | null; text: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [h, setH] = useState(width * ratio);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setNear(true), { root, rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root, near]);
  useEffect(() => {
    if (!near || !canvas.current || width < 20) return;
    let r: { cancel(): void } | null = null;
    let off = false;
    void doc.getPage(n).then((page) => {
      if (off || !canvas.current) return;
      const out = renderPage(page, canvas.current, width, text ? layer.current : null);
      setH(out.height);
      r = out;
    });
    return () => {
      off = true;
      r?.cancel();
    };
  }, [doc, n, width, near, text]);
  return (
    <div ref={ref} className="pdfpage" data-page={n} style={{ width, height: near ? h : width * ratio }} role="img" aria-label={`Page ${n} of ${total}`}>
      {near ? <canvas ref={canvas} aria-hidden="true" /> : null}
      {text && near ? <div ref={layer} className="textLayer" /> : null}
    </div>
  );
}

/** Pages stacked vertically in `scroller`; reports the page at the top third. */
function PdfPages({ pdf, width, scroller, text, onPage }: { pdf: PdfState; width: number; scroller: HTMLElement | null; text: boolean; onPage(n: number): void }) {
  useEffect(() => {
    if (!scroller) return;
    const f = () => {
      const mark = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      let cur = 1;
      const all = scroller.querySelectorAll<HTMLElement>(".pdfpage");
      all.forEach((el) => {
        if (el.getBoundingClientRect().top <= mark) cur = Number(el.dataset.page);
      });
      // Scrolled to the end: the last page is the current one even if it can't reach the mark.
      if (scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) cur = all.length || cur;
      onPage(cur);
    };
    scroller.addEventListener("scroll", f, { passive: true });
    return () => scroller.removeEventListener("scroll", f);
  }, [scroller, onPage]);
  if (!pdf.doc) return null;
  return (
    <>
      {Array.from({ length: pdf.pages }, (_, i) => (
        <PdfPage key={i} doc={pdf.doc!} n={i + 1} width={width} ratio={pdf.ratio} total={pdf.pages} root={scroller} text={text} />
      ))}
    </>
  );
}

export function scrollToPage(scroller: HTMLElement | null, n: number, smooth = false) {
  const el = scroller?.querySelector<HTMLElement>(`.pdfpage[data-page="${n}"]`);
  if (!scroller || !el) return;
  scroller.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
}

/** Width of an element's content box, kept up to date. */
function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const f = () => setW(el.clientWidth);
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

// ---------- card thumbnail and extras ----------

/** Small first-page / image thumbnail for the card; reports the PDF's page count. */
export function Thumb({ kind, url, name, onPages }: { kind: FileKind; url: string; name: string; onPages?(n: number): void }) {
  const src = previewUrl(url);
  if (kind === "image") {
    const s = safeImageSrc(src);
    return s ? <img className="fthumb" src={s} alt="" draggable={false} /> : null;
  }
  if (kind === "pdf") return <PdfThumb src={src} name={name} onPages={onPages} />;
  return null;
}

function PdfThumb({ src, onPages }: { src: string; name: string; onPages?(n: number): void }) {
  const pdf = usePdf(src);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (pdf.pages) onPages?.(pdf.pages);
  }, [pdf.pages, onPages]);
  useEffect(() => {
    if (!pdf.doc || !canvas.current) return;
    let r: { cancel(): void } | null = null;
    void pdf.doc.getPage(1).then((p) => canvas.current && (r = renderPage(p, canvas.current, 52)));
    return () => r?.cancel();
  }, [pdf.doc]);
  if (pdf.error || !pdf.doc) return null;
  return (
    <span className="fthumb pdf" aria-hidden="true">
      <canvas ref={canvas} />
    </span>
  );
}

/** Below the card row: the first lines of a text file, or native media controls. */
export function CardExtra({ kind, url, name }: { kind: FileKind; url: string; name: string }) {
  const src = previewUrl(url);
  if (kind === "video") return <video className="fmedia" src={safeHref(src)} controls preload="metadata" aria-label={name} />;
  if (kind === "audio") return <audio className="fmedia audio" src={safeHref(src)} controls preload="metadata" aria-label={name} />;
  if (kind === "text") return <TextLines src={src} lines={TEXT_LINES} name={name} />;
  return null;
}

function useText(src: string, enabled = true): { text: string | null; error: boolean; cut: boolean } {
  const [s, set] = useState<{ text: string | null; error: boolean; cut: boolean }>({ text: null, error: false, cut: false });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    fetch(src, { signal: ac.signal, credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok || !r.body) throw new Error(String(r.status));
        const reader = r.body.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done || !value) break;
          chunks.push(value);
          n += value.length;
          if (n >= TEXT_BYTES) {
            void reader.cancel();
            break;
          }
        }
        const all = new Uint8Array(Math.min(n, TEXT_BYTES));
        let o = 0;
        for (const c of chunks) {
          const part = c.subarray(0, all.length - o);
          all.set(part, o);
          o += part.length;
          if (o >= all.length) break;
        }
        set({ text: new TextDecoder().decode(all), error: false, cut: n >= TEXT_BYTES });
      })
      .catch((e) => !ac.signal.aborted && (console.debug("text preview", e), set({ text: null, error: true, cut: false })));
    return () => ac.abort();
  }, [src, enabled]);
  return s;
}

function TextLines({ src, lines, name }: { src: string; lines: number; name: string }) {
  const { text } = useText(src);
  if (text === null) return null;
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  const shown = all.slice(0, lines);
  return (
    <pre className="ftext" aria-label={`First lines of ${name}`}>
      {shown.join("\n")}
      {all.length > lines ? <span className="fmore">{"\n"}… {all.length - lines}+ more lines</span> : null}
    </pre>
  );
}

// ---------- inline PDF viewer (display: preview) ----------

export const defaultHeight = () => Math.min(900, Math.round(window.innerHeight * 0.7));
export const clampHeight = (h: number) => Math.max(240, Math.min(1600, Math.round(h)));

export function InlinePdf(props: {
  url: string;
  name: string;
  height: number | null;
  editable: boolean;
  onHeight(h: number | null): void;
  onExpand(page: number): void;
  /** Viewer handle so a closed full-screen viewer can put the page back. */
  bindGoto?(fn: (page: number) => void): void;
  menu: React.ReactNode;
}) {
  const src = previewUrl(props.url);
  const pdf = usePdf(src);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const inner = useWidth(scroller);
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(1);
  const [live, setLive] = useState<number | null>(null);
  const height = live ?? props.height ?? defaultHeight();
  const width = Math.max(120, Math.floor((inner - 24) * zoom));
  const pageNow = useRef(page);
  pageNow.current = page;
  useEffect(() => {
    if (pdf.doc) requestAnimationFrame(() => scrollToPage(scroller, pageNow.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  // Back from the full viewer: pages re-measure as the layout settles, so place the page again
  // a few times (stops at the first scroll by the person).
  useEffect(
    () =>
      props.bindGoto?.((n) => {
        scrollToPage(scroller, n);
        for (const ms of [120, 300, 700]) window.setTimeout(() => scrollToPage(scroller, n), ms);
      }),
    [scroller, props],
  );

  const startResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = height;
    let last = h0;
    const move = (ev: PointerEvent) => setLive((last = clampHeight(h0 + ev.clientY - y0)));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setLive(null);
      props.onHeight(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const keys = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "+" || e.key === "=") (e.preventDefault(), setZoom(zoomIn));
    else if (e.key === "-") (e.preventDefault(), setZoom(zoomOut));
    else if (e.key === "f" || e.key === "F") (e.preventDefault(), props.onExpand(page));
  };
  return (
    <div className="pdfv inline" style={{ height }} onKeyDown={keys}>
      <div className="pdfbar" role="toolbar" aria-label={`${props.name} preview`}>
        <span className="pdfname" title={props.name}>
          <Ic name="file-text" size={14} />
          <span>{props.name}</span>
        </span>
        <span className="pdfpg" aria-live="polite">
          {pdf.pages ? `${page} / ${pdf.pages}` : pdf.error ? "" : "…"}
        </span>
        <span className="vs" />
        <button className="ib" aria-label="Zoom out" title="Zoom out (−)" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(zoomOut)}>
          <Ic name="zoom-out" size={15} />
        </button>
        <span className="pdfz" aria-label={`Zoom ${Math.round(zoom * 100)} percent`}>
          {Math.round(zoom * 100)}%
        </span>
        <button className="ib" aria-label="Zoom in" title="Zoom in (+)" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(zoomIn)}>
          <Ic name="zoom-in" size={15} />
        </button>
        <button className={"ib" + (zoom === 1 ? " on" : "")} aria-label="Fit width" title="Fit width" aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
          <Ic name="fit-width" size={15} />
        </button>
        <span className="vs" />
        <button className="ib" aria-label="Expand to full screen" title="Expand (F)" onClick={() => props.onExpand(page)}>
          <Ic name="maximize-2" size={15} />
        </button>
        {props.menu}
      </div>
      <div ref={setScroller} className="pdfscroll" tabIndex={0} aria-label={`${props.name}, page ${page} of ${pdf.pages || 1}. Arrow keys scroll, F expands.`}>
        {pdf.error ? (
          <div className="pdferr" role="status">
            <Ic name="triangle-alert" />
            This PDF can't be shown here. Download it to open it.
          </div>
        ) : !pdf.doc ? (
          <div className="pdfpage skel" style={{ width: Math.max(120, inner - 24), height: (inner - 24) * pdf.ratio }} aria-label="Loading PDF" />
        ) : (
          <PdfPages pdf={pdf} width={width} scroller={scroller} text={false} onPage={setPage} />
        )}
      </div>
      {props.editable ? (
        <button
          className="pdfresize"
          aria-label={`Preview height, ${height} pixels`}
          title="Drag to resize"
          onPointerDown={startResize}
          onKeyDown={(e) => {
            const step = e.key === "ArrowUp" ? -40 : e.key === "ArrowDown" ? 40 : 0;
            if (!step) return;
            e.preventDefault();
            props.onHeight(clampHeight(height + step));
          }}
        >
          <span />
        </button>
      ) : null}
    </div>
  );
}

// ---------- full viewer / lightbox ----------

export interface ViewItem {
  kind: FileKind;
  name: string;
  size: number;
  url: string;
  pos: number;
  caption?: string;
}

/** Attachments (or images) of the canvas, in document order. */
export function collectItems(editor: Editor, family: "file" | "image"): ViewItem[] {
  const out: ViewItem[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (family === "file" && n.type.name === "fileAttachment" && n.attrs.url) {
      out.push({ kind: fileKind(n.attrs.mime, n.attrs.name), name: n.attrs.name || "Untitled file", size: Number(n.attrs.size) || 0, url: n.attrs.url, pos });
    } else if (family === "image" && n.type.name === "image" && n.attrs.src) {
      out.push({ kind: "image", name: n.attrs.alt || n.attrs.caption || "Image", size: 0, url: n.attrs.src, pos, caption: n.attrs.caption });
    }
    return !n.isAtom;
  });
  return out;
}

export interface ViewerOptions {
  items: ViewItem[];
  index: number;
  page?: number;
  fullscreen?: boolean;
  canDownload: boolean;
  opener?: HTMLElement | null;
  onClose?(state: { pos: number; page: number }): void;
}

let mounted: { root: Root; el: HTMLElement } | null = null;

export function openViewer(o: ViewerOptions) {
  closeViewer();
  const el = document.createElement("div");
  el.className = "ocviewer-host";
  document.body.appendChild(el);
  const root = createRoot(el);
  // A real modal: the canvas behind is inert (no focus, no screen reader access) while open.
  const app = document.getElementById("root");
  if (app) app.inert = true;
  mounted = { root, el };
  root.render(<Viewer {...o} />);
}

function closeViewer() {
  if (!mounted) return;
  const m = mounted;
  mounted = null;
  const app = document.getElementById("root");
  if (app) app.inert = false;
  m.root.unmount();
  m.el.remove();
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],[tabindex="0"],video,audio')].filter((e) => e.offsetParent !== null || e === document.activeElement);
}

function Viewer(o: ViewerOptions) {
  const [index, setIndex] = useState(o.index);
  const item = o.items[index];
  const ref = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState(o.page ?? 1);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const pageRef = useRef(page);
  pageRef.current = page;
  const wantFull = useRef(!!o.fullscreen);

  const closing = useRef(false);
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const st = { pos: item.pos, page: pageRef.current };
    const finish = () => {
      closeViewer();
      o.onClose?.(st);
      o.opener?.focus({ preventScroll: true });
    };
    // Leave full screen first so the canvas has its size back when the page is restored.
    if (document.fullscreenElement) document.exitFullscreen().then(finish, finish);
    else finish();
  }, [item, o]);

  // Full screen: the Fullscreen API when the browser allows it, else this overlay already
  // fills the viewport. Leaving full screen (Esc is taken by the browser) closes a viewer that
  // was opened with Expand.
  const toggleFull = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) {
      wantFull.current = false;
      void document.exitFullscreen().catch(() => undefined);
    } else if (el.requestFullscreen) {
      el.requestFullscreen().then(
        () => setFull(true),
        () => setFull(false),
      );
    }
  }, []);
  useEffect(() => {
    const f = () => {
      const on = document.fullscreenElement === ref.current;
      setFull(on);
      if (!on && wantFull.current) close();
    };
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, [close]);
  useEffect(() => {
    ref.current?.focus();
    if (o.fullscreen) toggleFull();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = (d: number) => {
    const next = index + d;
    if (next < 0 || next >= o.items.length) return;
    setIndex(next);
    setPage(1);
    setZoom(1);
  };
  const pdf = usePdf(item.kind === "pdf" ? previewUrl(item.url) : "");
  const pages = item.kind === "pdf" ? pdf.pages : 0;
  const goPage = (n: number) => {
    if (!pages) return;
    const p = Math.max(1, Math.min(pages, n));
    setPage(p);
    // Instant, so the page shown and the page counted never disagree mid-animation.
    scrollToPage(scroller, p);
  };
  // Put the page we were asked for in view once the pages exist.
  const placed = useRef(false);
  useEffect(() => {
    if (placed.current || !pdf.doc || !scroller) return;
    placed.current = true;
    if ((o.page ?? 1) > 1) requestAnimationFrame(() => scrollToPage(scroller, o.page ?? 1));
  }, [pdf.doc, scroller, o.page]);

  const zoomable = item.kind === "pdf" || item.kind === "image";
  const onKey = (e: React.KeyboardEvent) => {
    const inField = (e.target as HTMLElement).closest("input,textarea,video,audio");
    if (e.key === "Escape") {
      e.preventDefault();
      wantFull.current = false;
      return close();
    }
    if (e.key === "Tab") {
      const f = focusables(ref.current!);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      return;
    }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      if (pages > 1 && ((d > 0 && page < pages) || (d < 0 && page > 1))) goPage(page + d);
      else go(d);
    } else if (zoomable && (e.key === "+" || e.key === "=")) (e.preventDefault(), setZoom(zoomIn));
    else if (zoomable && e.key === "-") (e.preventDefault(), setZoom(zoomOut));
    else if (zoomable && e.key === "0") (e.preventDefault(), setZoom(1));
    else if (e.key === "f" || e.key === "F") (e.preventDefault(), (wantFull.current = !document.fullscreenElement), toggleFull());
  };

  // Phones: a horizontal swipe turns the page (PDF) or moves to the next item.
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    swipe.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || zoom > 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 50 || Date.now() - s.t > 600) return;
    const d = dx < 0 ? 1 : -1;
    if (pages > 1 && ((d > 0 && page < pages) || (d < 0 && page > 1))) goPage(page + d);
    else go(d);
  };

  const inner = useWidth(scroller);
  const pageWidth = Math.max(160, Math.floor(Math.min(inner - 32, 1000) * zoom));
  // Zoom keeps the current page in view.
  useEffect(() => {
    if (pdf.doc) requestAnimationFrame(() => scrollToPage(scroller, pageRef.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  const ext = (item.name.split(".").pop() ?? "").toUpperCase();
  const href = safeHref(openUrl(item.url));
  const many = o.items.length > 1;

  return (
    <div
      ref={ref}
      className={"ocviewer" + (full ? " full" : "")}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKey}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <header className="vbar">
        <span className={"vtile"} aria-hidden="true">
          <Ic name={kindIcon(item.kind, "", item.name)} size={16} />
        </span>
        <span className="vtitle">
          <b title={item.name}>{item.name}</b>
          <span>{[item.kind === "image" ? "" : ext, fmtSize(item.size), many ? `${index + 1} of ${o.items.length}` : ""].filter(Boolean).join(" · ")}</span>
        </span>
        {pages ? (
          <span className="vpg" aria-live="polite">
            Page {page} of {pages}
          </span>
        ) : null}
        <span className="sp" />
        {zoomable ? (
          <span className="vgroup" role="group" aria-label="Zoom">
            <button className="ib" aria-label="Zoom out" title="Zoom out (−)" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(zoomOut)}>
              <Ic name="zoom-out" />
            </button>
            <span className="vz">{Math.round(zoom * 100)}%</span>
            <button className="ib" aria-label="Zoom in" title="Zoom in (+)" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(zoomIn)}>
              <Ic name="zoom-in" />
            </button>
            <button className={"ib" + (zoom === 1 ? " on" : "")} aria-label={item.kind === "pdf" ? "Fit width" : "Fit to screen"} title={item.kind === "pdf" ? "Fit width (0)" : "Fit to screen (0)"} aria-pressed={zoom === 1} onClick={() => setZoom(1)}>
              <Ic name="fit-width" />
            </button>
          </span>
        ) : null}
        {o.canDownload && href ? (
          <a className="ib" href={href} download={item.name} aria-label={`Download ${item.name}`} title="Download">
            <Ic name="download" />
          </a>
        ) : null}
        {href ? (
          <a className="ib" href={href} target="_blank" rel="noopener noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
            <Ic name="external-link" />
          </a>
        ) : null}
        <button className="ib" aria-label={full ? "Exit full screen" : "Full screen"} title={full ? "Exit full screen (F)" : "Full screen (F)"} aria-pressed={full} onClick={() => ((wantFull.current = false), toggleFull())}>
          <Ic name={full ? "minimize-2" : "maximize-2"} />
        </button>
        <button className="ib" aria-label="Close preview" title="Close (Esc)" onClick={() => ((wantFull.current = false), close())}>
          <Ic name="x" />
        </button>
      </header>
      <div ref={setScroller} className={"vbody k-" + item.kind} tabIndex={0} aria-label={item.kind === "pdf" ? `Pages of ${item.name}` : item.name}>
        {item.kind === "pdf" ? (
          pdf.error ? (
            <NoPreview item={item} href={o.canDownload ? href : undefined} reason="This PDF can't be shown here." />
          ) : !pdf.doc ? (
            <div className="pdfpage skel" style={{ width: pageWidth, height: pageWidth * pdf.ratio }} aria-label="Loading PDF" />
          ) : (
            <PdfPages pdf={pdf} width={pageWidth} scroller={scroller} text onPage={setPage} />
          )
        ) : item.kind === "image" ? (
          <ZoomImage key={item.url} src={item.url} alt={item.caption || item.name} zoom={zoom} setZoom={setZoom} />
        ) : item.kind === "video" ? (
          <video className="vmedia" src={safeHref(previewUrl(item.url))} controls autoPlay={false} aria-label={item.name} />
        ) : item.kind === "audio" ? (
          <div className="vaudio">
            <Ic name="file-audio" size={40} />
            <audio src={safeHref(previewUrl(item.url))} controls aria-label={item.name} />
          </div>
        ) : item.kind === "text" ? (
          <FullText src={previewUrl(item.url)} name={item.name} />
        ) : (
          <NoPreview item={item} href={o.canDownload ? href : undefined} reason="There's no preview for this kind of file." />
        )}
      </div>
      {many ? (
        <>
          <button className="vnav prev" aria-label="Previous file" title="Previous (←)" disabled={index === 0} onClick={() => go(-1)}>
            <Ic name="chevron-left" size={20} />
          </button>
          <button className="vnav next" aria-label="Next file" title="Next (→)" disabled={index === o.items.length - 1} onClick={() => go(1)}>
            <Ic name="chevron-right" size={20} />
          </button>
        </>
      ) : null}
    </div>
  );
}

function NoPreview({ item, href, reason }: { item: ViewItem; href?: string; reason: string }) {
  return (
    <div className="vnone">
      <span className="vtile big" aria-hidden="true">
        <Ic name={kindIcon(item.kind, "", item.name)} size={28} />
      </span>
      <p>{reason}</p>
      {href ? (
        <a className="btn sm" href={href} download={item.name}>
          <Ic name="download" size={14} />
          Download {fmtSize(item.size)}
        </a>
      ) : null}
    </div>
  );
}

function FullText({ src, name }: { src: string; name: string }) {
  const { text, error, cut } = useText(src);
  if (error) return <p className="vnone">This file can't be read here.</p>;
  if (text === null) return <div className="pdfpage skel" style={{ width: "min(900px, 100%)", height: 400 }} aria-label="Loading" />;
  return (
    <pre className="vtext" aria-label={name}>
      {text}
      {cut ? "\n\n… (only the first 512 KB are shown)" : ""}
    </pre>
  );
}

/** Image with zoom (buttons, wheel with ⌘/Ctrl, pinch) and pan (drag) once zoomed in. */
function ZoomImage({ src, alt, zoom, setZoom }: { src: string; alt: string; zoom: number; setZoom(f: (z: number) => number): void }) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; px: number; py: number; d: number; z: number } | null>(null);
  useEffect(() => {
    if (zoom <= 1) setPan({ x: 0, y: 0 });
  }, [zoom]);
  const s = safeImageSrc(previewUrl(src));
  if (!s) return <p className="vnone">This image can't be shown here.</p>;
  const dist = () => {
    const [a, b] = [...pts.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  return (
    <div
      className={"vimg" + (zoom > 1 ? " zoomed" : "")}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        start.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y, d: dist(), z: zoom };
      }}
      onPointerMove={(e) => {
        if (!pts.current.has(e.pointerId) || !start.current) return;
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.current.size === 2 && start.current.d) {
          const z0 = start.current.z;
          const d0 = start.current.d;
          setZoom(() => Math.max(0.5, Math.min(4, z0 * (dist() / d0))));
        } else if (zoom > 1) setPan({ x: start.current.px + e.clientX - start.current.x, y: start.current.py + e.clientY - start.current.y });
      }}
      onPointerUp={(e) => {
        pts.current.delete(e.pointerId);
        start.current = pts.current.size ? { ...start.current!, d: dist(), z: zoom } : null;
      }}
      onPointerCancel={(e) => pts.current.delete(e.pointerId)}
      onWheel={(e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        setZoom((z) => (e.deltaY < 0 ? zoomIn(z) : zoomOut(z)));
      }}
      onDoubleClick={() => setZoom((z) => (z > 1 ? 1 : 2))}
    >
      <img src={s} alt={alt} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} />
    </div>
  );
}
