// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// The node views of the atom blocks: file attachment, image, link card and embed. Their own
// chunk (WEB-08 budget), fetched as soon as the editor's code runs (`loadAtomViews` in
// nodes.tsx), so it is there before a document arrives; the schema stays in nodes.tsx.
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { lazy, Suspense, useEffect, useRef, useState, type DragEvent } from "react";
import { CirclePlay, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileVideo, Globe, ImagePlus, Link2, Maximize2, Paperclip } from "lucide-react";
import { Ic, ICONS } from "../icons";
import { useBridge, bridge } from "../lib/bridge";
import { EMBED_ALLOW, EMBED_SANDBOX, hostOf, providerLabel, resolveEmbed } from "../lib/embeds";
import { toast, useStore } from "../lib/store";
import { cancelUpload, retryUpload, uploadInto, uploadNow, uploadStore, type UploadState } from "../lib/uploads";
import { pendingPreviews, pendingSizes, resolveAsset } from "../lib/assets";
import { Popover } from "../components/overlay";
import { safeHref, safeImageSrc } from "../lib/urls";
import { cardImageSrc, previewAttrs, unfurlFor } from "../lib/unfurl";
import { clampWidth } from "./imagelayout";
import { FILE_EVENT, fileDisplay, fileKind, fmtSize, hasBytes, kindIcon, openUrl } from "./files/kind";
import { fileActions, type FileActionId } from "./files/actions";
import { createThread, newThreadId } from "../lib/comments";

// The icons only these views draw, registered before any of them renders.
Object.assign(ICONS, {
  "file-archive": FileArchive, "file-audio": FileAudio, "file-code": FileCode, "file-image": FileImage, "file-video": FileVideo,
  "file-spreadsheet": FileSpreadsheet, "image-plus": ImagePlus, "circle-play": CirclePlay, "maximize-2": Maximize2,
  paperclip: Paperclip, "link-2": Link2, globe: Globe,
});

export function BookmarkView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const { url, title, description, site, image } = node.attrs as Record<string, string>;
  // UNF-01: a card a person just inserted asks the server for its preview; while it
  // loads, and if it fails, the card is today's hostname card.
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    const p = editor.isEditable ? unfurlFor(url) : null;
    if (!p) return;
    let live = true;
    setPhase("loading");
    void p.then((preview) => {
      if (!live) return;
      if (!preview) return setPhase("failed");
      updateAttributes(previewAttrs(url, preview));
      setPhase("idle");
    });
    return () => {
      live = false;
    };
  }, [url, editor, updateAttributes]);
  useEffect(() => setImgFailed(false), [image]);
  const imgSrc = imgFailed ? undefined : cardImageSrc(image);
  return (
    <NodeViewWrapper data-drag-handle="">
      <a
        className={phase === "loading" ? "bookmark loading" : "bookmark"}
        href={safeHref(url)}
        target="_blank"
        rel="noopener noreferrer"
        contentEditable={false}
        aria-busy={phase === "loading" || undefined}
        data-unfurl={phase}
        onClick={() => bridge.linkClick(url)}
      >
        <div className="bk">
          <div className="bt">{title || hostOf(url)}</div>
          {description ? <div className="bd">{description}</div> : null}
          <div className="bs">
            <Ic name="globe" size={12} />
            {site || hostOf(url)}
          </div>
        </div>
        <div className="bthumb">
          {imgSrc ? <img src={imgSrc} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setImgFailed(true)} /> : <Ic name="link-2" size={28} />}
        </div>
      </a>
    </NodeViewWrapper>
  );
}

export function EmbedView({ node, updateAttributes, editor }: ReactNodeViewProps) {
  const { provider, url, title } = node.attrs as Record<string, string>;
  const info = url ? resolveEmbed(url) : null;
  const [playing, setPlaying] = useState(false);
  const [draft, setDraft] = useState("");
  const label = info?.label ?? providerLabel(provider);
  if (!info) {
    return (
      <NodeViewWrapper>
        <div className="embed" contentEditable={false}>
          <div className="ehead">
            <Ic name="circle-play" size={14} />
            <span className="pv">{url ? "Can't embed this link" : "Embed"}</span>
            <span className="et">{title || (url ? hostOf(url) : "YouTube, Vimeo, Loom, Figma or Google Maps")}</span>
          </div>
          {editor.isEditable ? (
            <form
              className="pad"
              style={{ display: "flex", gap: 8, padding: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                const r = resolveEmbed(draft);
                if (!r) return toast("Only YouTube, Vimeo, Loom, Figma and Google Maps links can be embedded", { icon: "shield-check" });
                updateAttributes({ url: draft.trim(), provider: r.provider, title: title || hostOf(draft) });
              }}
            >
              <input className="pin" placeholder="Paste a video, design or map link" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Embed link" />
              <button className="btn sm" type="submit">
                Embed
              </button>
            </form>
          ) : null}
        </div>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <div className="embed" contentEditable={false}>
        <div className="ehead">
          <Ic name="circle-play" size={14} />
          <span className="pv">{label}</span>
          <span className="et">{title || hostOf(url)}</span>
          <span className="tag">
            <Ic name="shield-check" size={12} />
            Sandboxed
          </span>
        </div>
        <div className={"ev" + (info.tall ? " tall" : "")}>
          {playing ? (
            <iframe src={info.src} title={title || label} sandbox={EMBED_SANDBOX} allow={EMBED_ALLOW} referrerPolicy="strict-origin-when-cross-origin" loading="lazy" allowFullScreen />
          ) : (
            <>
              <button className="play" onClick={() => setPlaying(true)} aria-label={`Load ${label}`}>
                <Ic name={info.provider === "youtube" || info.provider === "vimeo" || info.provider === "loom" ? "play" : "maximize-2"} size={26} />
              </button>
              <span className="ecap">{title || hostOf(url)}</span>
            </>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

function fileTone(mime: string, name: string): string {
  if (/pdf/.test(mime) || /\.pdf$/i.test(name)) return "red";
  if (/sheet|csv|excel/.test(mime) || /\.(xlsx?|csv)$/i.test(name)) return "green";
  if (/presentation|powerpoint/.test(mime)) return "amber";
  if (/^(image|video|audio)\//.test(mime)) return "purple";
  if (/zip|compressed/.test(mime)) return "gray";
  return "blue";
}

/** Local upload state for a node's transient `upload` attr (only the uploader has it). */
function useUpload(node: ReactNodeViewProps["node"]): [string | null, UploadState | undefined] {
  const id = (node.attrs.upload as string | null) ?? null;
  const all = useStore(uploadStore);
  return [id, id ? all[id] : undefined];
}

function UploadStatus({ id, up, label }: { id: string; up: UploadState; label: string }) {
  if (up.state === "error")
    return (
      <span className="upchip bad" role="status">
        <Ic name="triangle-alert" size={13} />
        <span className="ut">{label} didn't upload</span>
        <button onClick={() => retryUpload(id)}>
          <Ic name="rotate-ccw" size={13} />
          Retry
        </button>
        <button className="x" onClick={() => cancelUpload(id)} aria-label="Remove" title="Remove">
          <Ic name="x" size={13} />
        </button>
      </span>
    );
  return (
    <span className="upchip" role="status" aria-label={`Uploading, ${Math.round(up.progress * 100)}%`}>
      <Ic name="loader-circle" size={13} className="spin" />
      <span className="ut">Uploading {Math.round(up.progress * 100)}%</span>
    </span>
  );
}

const FilePreview = () => import("./files/preview");
const LazyThumb = lazy(() => FilePreview().then((m) => ({ default: m.Thumb })));
const LazyExtra = lazy(() => FilePreview().then((m) => ({ default: m.CardExtra })));
const LazyInlinePdf = lazy(() => FilePreview().then((m) => ({ default: m.InlinePdf })));

export function FileView({ node, updateAttributes, editor, getPos, selected }: ReactNodeViewProps) {
  const { name, size, url, mime } = node.attrs as { name: string; size: number; url: string; mime: string };
  const b = useBridge();
  const [upId, up] = useUpload(node);
  const kind = fileKind(mime, name);
  const display = fileDisplay(node.attrs.display, kind);
  const ext = (name.split(".").pop() ?? "").toUpperCase();
  const [pages, setPages] = useState(0);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const gotoRef = useRef<((p: number) => void) | null>(null);
  const role = b.env?.role ?? (editor.isEditable ? "edit" : "view");
  const editable = editor.isEditable;
  const canDownload = b.session?.perms?.download !== false;
  const ready = hasBytes(url) && !up;
  const pos = () => (typeof getPos === "function" ? getPos() : undefined);

  const open = (expand: boolean, page = 1) => {
    const at = pos();
    if (at === undefined || !ready) return;
    void FilePreview().then((m) => {
      const items = m.collectItems(editor, "file");
      const index = Math.max(0, items.findIndex((i) => i.pos === at));
      m.openViewer({
        items,
        index,
        page,
        fullscreen: expand,
        canDownload,
        opener: wrap.current?.querySelector<HTMLElement>(".attach, .pdfscroll") ?? null,
        onClose: (st) => st.pos === at && gotoRef.current?.(st.page),
      });
    });
  };
  const act = (id: FileActionId) => {
    setMenu(null);
    const at = pos();
    // Each file action is its own undo step (not merged with typing just before it).
    yUndoPluginKey.getState(editor.state)?.undoManager?.stopCapturing();
    switch (id) {
      case "preview":
        return open(false);
      case "expand":
        return open(true);
      case "display":
        return updateAttributes({ display: display === "preview" ? "card" : "preview" });
      case "download": {
        const a = document.createElement("a");
        a.href = safeHref(openUrl(url)) ?? "";
        a.download = name;
        a.rel = "noopener";
        a.click();
        return;
      }
      case "copy": {
        const link = new URL(url, window.location.href).toString();
        void navigator.clipboard?.writeText(link).then(
          () => toast("Link copied", { icon: "link" }),
          () => toast("Couldn't copy the link", { icon: "triangle-alert" }),
        );
        return;
      }
      case "rename":
        return setRenaming(true);
      case "replace":
        return b.pickFile("*/*", async (f) => {
          setBusy(true);
          try {
            const r = await uploadNow(f);
            updateAttributes({ url: r.url, name: f.name, size: f.size, mime: r.mime || f.type });
            toast(`Replaced with “${f.name}”`, { icon: "refresh-cw" });
          } catch {
            toast("The file didn't upload. Try again.", { icon: "triangle-alert" });
          } finally {
            setBusy(false);
          }
        });
      case "comment": {
        const id = newThreadId();
        createThread(b.doc, id, name || "File");
        return b.openThread(id);
      }
      case "delete": {
        if (at === undefined) return;
        editor.chain().focus().deleteRange({ from: at, to: at + node.nodeSize }).run();
        toast(`Deleted “${name || "file"}”`, { icon: "trash-2", action: { label: "Undo", run: () => editor.commands.undo() } });
        return;
      }
    }
  };
  // The block menu reaches the card through a DOM event (it has no handle on this view).
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    const el = wrap.current;
    const f = (e: Event) => actRef.current((e as CustomEvent<FileActionId>).detail);
    el?.addEventListener(FILE_EVENT, f);
    return () => el?.removeEventListener(FILE_EVENT, f);
  }, []);

  const actions = fileActions({ kind, display, role, editable, canDownload, hasFile: ready, inBlockMenu: false });
  const menuButton = actions.length ? (
    <button className="ib" aria-label={`Actions for ${name || "file"}`} title="More actions" aria-haspopup="menu" aria-expanded={!!menu} onClick={(e) => setMenu(menu ? null : e.currentTarget)}>
      <Ic name="ellipsis" size={15} />
    </button>
  ) : null;
  const menuPop = menu ? (
    <Popover anchor={menu} onClose={() => setMenu(null)} title="File" minWidth={220} alignRight>
      {actions.map((a) => (
        <span key={a.id} style={{ display: "contents" }}>
          {a.sepBefore ? <div className="msep" /> : null}
          <button className={"mi" + (a.danger ? " danger" : "")} onClick={() => act(a.id)}>
            <Ic name={a.icon} />
            {a.label}
            {a.hint ? <span className="mk">{a.hint}</span> : null}
          </button>
        </span>
      ))}
    </Popover>
  ) : null;

  const nameEl = renaming ? (
    <RenameInput
      value={name}
      onDone={(v) => {
        setRenaming(false);
        if (v !== null && v.trim() && v.trim() !== name) updateAttributes({ name: v.trim() });
      }}
    />
  ) : (
    <div className="fname">{name || "Untitled file"}</div>
  );
  const meta = [ext, kind === "pdf" && pages ? `${pages} ${pages === 1 ? "page" : "pages"}` : "", fmtSize(Number(size))].filter(Boolean).join(" · ") || "File";

  if (display === "preview" && ready) {
    return (
      <NodeViewWrapper>
        <div ref={wrap} className={"filev" + (selected ? " sel" : "")} contentEditable={false} data-display="preview">
          {renaming ? <div className="attach renaming">{nameEl}</div> : null}
          <Suspense fallback={<div className="pdfv inline skel" style={{ height: Math.min(900, Math.round(window.innerHeight * 0.7)) }} />}>
            <LazyInlinePdf
              url={url}
              name={name}
              height={typeof node.attrs.height === "number" ? node.attrs.height : null}
              editable={editable}
              onHeight={(h) => updateAttributes({ height: h })}
              onExpand={(page) => open(true, page)}
              bindGoto={(fn) => (gotoRef.current = fn)}
              menu={menuButton}
            />
          </Suspense>
          {menuPop}
        </div>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <div ref={wrap} className={"filev" + (selected ? " sel" : "")} data-display="card">
        <div
          className={"attach" + (up ? " uploading" : "") + (ready ? " openable" : "")}
          contentEditable={false}
          tabIndex={ready ? 0 : undefined}
          role={ready ? "button" : undefined}
          aria-label={ready ? `${name || "File"}, ${meta}. Press Enter to preview.` : undefined}
          onClick={(e) => {
            if (!ready || renaming || (e.target as HTMLElement).closest("button,a,input")) return;
            open(false);
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || !ready) return;
            if (e.key === "Enter" || e.key === " ") (e.preventDefault(), open(false));
          }}
        >
          <span className={`ftile tone-${fileTone(mime, name)}`}>
            {ready && (kind === "pdf" || kind === "image") ? (
              <Suspense fallback={<Ic name={kindIcon(kind, mime, name)} />}>
                <Ic name={kindIcon(kind, mime, name)} className="ficon" />
                <LazyThumb kind={kind} url={url} name={name} onPages={setPages} />
              </Suspense>
            ) : (
              <Ic name={kindIcon(kind, mime, name)} />
            )}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            {nameEl}
            <div className="fmeta">{meta}</div>
          </div>
          {up && upId ? (
            <UploadStatus id={upId} up={up} label="File" />
          ) : busy ? (
            <span className="ib" aria-label="Uploading the new file">
              <Ic name="loader-circle" className="spin" />
            </span>
          ) : url && canDownload ? (
            <a className="ib" href={safeHref(openUrl(url))} download={name} target="_blank" rel="noopener noreferrer" title="Download" aria-label={`Download ${name}`}>
              <Ic name="download" />
            </a>
          ) : (
            <span className="ib" title={url ? "Downloads are turned off" : "Stored with the canvas"} aria-hidden>
              <Ic name="paperclip" />
            </span>
          )}
          {menuButton}
          {up?.state === "uploading" ? <span className="upbar" style={{ transform: `scaleX(${Math.max(0.04, up.progress)})` }} /> : null}
        </div>
        {ready && (kind === "text" || kind === "video" || kind === "audio") ? (
          <Suspense fallback={null}>
            <LazyExtra kind={kind} url={url} name={name} />
          </Suspense>
        ) : null}
        {menuPop}
      </div>
    </NodeViewWrapper>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone(v: string | null): void }) {
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (x: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(x);
  };
  return (
    <input
      className="frename"
      value={v}
      autoFocus
      aria-label="File name"
      onFocus={(e) => {
        const dot = e.currentTarget.value.lastIndexOf(".");
        e.currentTarget.setSelectionRange(0, dot > 0 ? dot : e.currentTarget.value.length);
      }}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.preventDefault(), finish(v));
        else if (e.key === "Escape") (e.preventDefault(), finish(null));
      }}
    />
  );
}

export function ImageView({ node, updateAttributes, editor, selected, getPos }: ReactNodeViewProps) {
  // Lightbox with zoom, pan and prev/next between the canvas's images (FILE-01).
  const expand = (e?: { currentTarget: EventTarget }) => {
    const at = typeof getPos === "function" ? getPos() : undefined;
    const opener = (e?.currentTarget as HTMLElement | undefined) ?? null;
    if (at === undefined) return;
    void FilePreview().then((m) => {
      const items = m.collectItems(editor, "image");
      m.openViewer({ items, index: Math.max(0, items.findIndex((i) => i.pos === at)), canDownload: bridge.session?.perms?.download !== false, opener });
    });
  };
  const { src, alt, caption } = node.attrs as { src: string; alt: string; caption: string };
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upId, up] = useUpload(node);
  const b = useBridge();
  const fill = (f: File | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    uploadInto(editor, f, (a) => updateAttributes({ ...a, alt: alt || f.name.replace(/\.[^.]+$/, "") }));
  };
  const replace = async (f: File | undefined) => {
    if (!f || !/^image\//.test(f.type)) return;
    setBusy(true);
    try {
      const r = await uploadNow(f);
      updateAttributes({ src: r.url });
    } catch {
      toast("The image didn't upload. Try again.", { icon: "triangle-alert" });
    } finally {
      setBusy(false);
    }
  };
  const shown = up?.preview ?? src;
  const pendingMine = pendingPreviews.has(src) || (!!node.attrs.pendingBy && node.attrs.pendingBy === b.session?.user?.id);
  const width = clampWidth(node.attrs.width);
  const align = (["left", "center", "right"].includes(String(node.attrs.align)) ? node.attrs.align : "center") as ImageAlign;
  const figRef = useRef<HTMLElement>(null);
  const [live, setLive] = useState<number | null>(null);
  // Drag the corner handle to resize (percent of the text column); arrows on the focused handle step 5 %.
  const startResize = (e: React.PointerEvent<HTMLButtonElement>) => {
    const fig = figRef.current;
    const col = fig?.parentElement;
    if (!fig || !col) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const left = fig.getBoundingClientRect().left;
    const total = col.getBoundingClientRect().width;
    let last = width ?? 100;
    const move = (ev: PointerEvent) => {
      const px = align === "center" ? (ev.clientX - (left + fig.getBoundingClientRect().width / 2)) * 2 : align === "right" ? fig.getBoundingClientRect().right - ev.clientX : ev.clientX - left;
      last = clampWidth(Math.round((px / total) * 100)) ?? 100;
      setLive(last);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      setLive(null);
      updateAttributes({ width: last >= 100 ? null : last });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const shownWidth = live ?? width;
  if (!shown) {
    return (
      <NodeViewWrapper>
        <button
          className={"upl" + (over ? " over" : "")}
          contentEditable={false}
          disabled={!editor.isEditable || !!up}
          onClick={() => b.pickFile("image/*", fill)}
          onDragOver={(e: DragEvent) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            setOver(false);
            fill(e.dataTransfer.files[0]);
          }}
        >
          <Ic name="image-plus" />
          {editor.isEditable ? "Upload an image or drop one here" : "Image"}
        </button>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper>
      <figure
        ref={figRef}
        className={"figure" + (selected ? " sel" : "")}
        data-align={align}
        style={{ width: shownWidth ? `${shownWidth}%` : undefined }}
      >
        <div className={"fwrap" + (up ? " uploading" : "")} contentEditable={false}>
          {safeImageSrc(resolveAsset(shown)) ? (
            <img src={safeImageSrc(resolveAsset(shown))} alt={alt || caption || ""} draggable={false} />
          ) : (
            <div className="fblocked" role="img" aria-label={alt || caption || "Image that can't be shown"}>
              <Ic name="image-plus" />
              This image can't be shown here.{editor.isEditable ? " Replace it to fix it." : ""}
            </div>
          )}
          {up && upId ? (
            <div className="fup">
              <UploadStatus id={upId} up={up} label="Image" />
              {up.state === "uploading" ? <span className="upbar" style={{ transform: `scaleX(${Math.max(0.04, up.progress)})` }} /> : null}
            </div>
          ) : editor.isEditable ? (
            <>
              <div className="fbar" role="toolbar" aria-label="Image">
                {(["left", "center", "right"] as const).map((a) => (
                  <button key={a} className={"ib" + (align === a ? " on" : "")} title={`Align ${a}`} aria-label={`Align ${a}`} aria-pressed={align === a} onClick={() => updateAttributes({ align: a === "center" ? null : a })}>
                    <Ic name={`align-${a}`} size={14} />
                  </button>
                ))}
                <span className="vs" />
                {IMAGE_SIZES.map(([label, w]) => (
                  <button key={label} className={"ib txt" + ((width ?? 100) === w ? " on" : "")} title={`${label} (${w} %)`} aria-label={`${label} size`} aria-pressed={(width ?? 100) === w} onClick={() => updateAttributes({ width: w >= 100 ? null : w })}>
                    {label[0]}
                  </button>
                ))}
                <span className="vs" />
                <button className="ib" title="Replace" aria-label="Replace image" disabled={busy} onClick={() => b.pickFile("image/*", replace)}>
                  <Ic name={busy ? "loader-circle" : "image-plus"} size={14} className={busy ? "spin" : ""} />
                </button>
                <button className="ib" title="Expand (F)" aria-label="Expand image" onClick={expand}>
                  <Ic name="maximize-2" size={14} />
                </button>
              </div>
              <button
                className="fresize"
                aria-label={`Image width, ${shownWidth ?? 100} percent`}
                title="Drag to resize"
                onPointerDown={startResize}
                onKeyDown={(e) => {
                  const step = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -5 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 5 : 0;
                  if (!step) return;
                  e.preventDefault();
                  const next = clampWidth((width ?? 100) + step) ?? 100;
                  updateAttributes({ width: next >= 100 ? null : next });
                }}
              />
            </>
          ) : (
            <button className="fexpand ib" title="Expand" aria-label="Expand image" onClick={expand}>
              <Ic name="maximize-2" size={14} />
            </button>
          )}
        </div>
        {typeof src === "string" && src.startsWith("oc-pending:") ? (
          // OFF-05, prototype 1b/4a: an image added offline says where its bytes are.
          <figcaption className={"fpending" + (pendingMine ? "" : " r")} contentEditable={false}>
            <Ic name={pendingMine ? "hard-drive" : "loader-circle"} size={14} />
            {pendingMine ? ["Waiting to upload", fmtSize(pendingSizes.get(src) ?? 0), "kept on this device"].filter(Boolean).join(" · ") : "Uploading from the device it was added on…"}
          </figcaption>
        ) : null}
        <CaptionInput value={caption} editable={editor.isEditable} onChange={(v) => updateAttributes({ caption: v })} />
      </figure>
    </NodeViewWrapper>
  );
}

export type ImageAlign = "left" | "center" | "right";

const IMAGE_SIZES: [string, number][] = [
  ["Small", 33],
  ["Medium", 60],
  ["Large", 100],
];

function CaptionInput({ value, editable, onChange }: { value: string; editable: boolean; onChange(v: string): void }) {
  const [v, setV] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setV(value);
  }, [value]);
  if (!editable && !value) return null;
  return (
    <input
      className="fcap"
      value={v}
      readOnly={!editable}
      placeholder={editable ? "Add a caption" : ""}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        if (v !== value) onChange(v);
      }}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      aria-label="Caption"
    />
  );
}
