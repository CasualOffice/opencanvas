// Image and file uploads (WEB-03). A pasted, dropped or picked file is
// inserted at once as an `image` / `fileAttachment` node carrying a transient
// `upload` id; the bytes go to `POST /v1/assets?ticket=` (proxied to the host)
// and the node gets the returned URL. Progress and failures are local to the
// person uploading: other people only ever see the finished URL.
import type { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { bridge } from "./bridge";
import { createStore, toast } from "./store";

export const MAX_UPLOAD = 25 * 1024 * 1024; // docs/15 §6

export interface UploadState {
  file: File;
  kind: "image" | "file";
  /** 0..1 */
  progress: number;
  state: "uploading" | "error";
  /** local object URL, so the image shows while it uploads */
  preview?: string;
  editor: Editor;
}

export const uploadStore = createStore<Record<string, UploadState>>({});

const patch = (id: string, p: Partial<UploadState> | null) =>
  uploadStore.set((all) => {
    const next = { ...all };
    if (p === null) delete next[id];
    else if (next[id]) next[id] = { ...next[id], ...p };
    return next;
  });

const newId = () => "up_" + Math.random().toString(36).slice(2, 10);

const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/.test(f.type);

/** Finds the node that carries `upload: id` and replaces its attrs. */
function finish(editor: Editor, id: string, attrs: Record<string, unknown>): boolean {
  let done = false;
  const { state } = editor;
  state.doc.descendants((n, pos) => {
    if (done || n.attrs.upload !== id) return !done;
    editor.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs, upload: null }));
    done = true;
    return false;
  });
  return done;
}

async function run(id: string) {
  const u = uploadStore.get()[id];
  if (!u) return;
  patch(id, { state: "uploading", progress: 0 });
  try {
    const up = await bridge.upload(u.file, (p) => patch(id, { progress: p }));
    const attrs = u.kind === "image" ? { src: up.url } : { url: up.url, mime: up.mime, size: up.size, name: up.name };
    if (!finish(u.editor, id, attrs) && u.preview) URL.revokeObjectURL(u.preview);
    // Keep the local preview a moment so the swap to the remote URL doesn't flash.
    window.setTimeout(() => {
      const cur = uploadStore.get()[id];
      if (cur?.preview) URL.revokeObjectURL(cur.preview);
      patch(id, null);
    }, 4000);
  } catch {
    patch(id, { state: "error" });
  }
}

/** Retries a failed upload. */
export const retryUpload = (id: string) => void run(id);

/** Forgets a failed upload and removes its block. */
export function cancelUpload(id: string) {
  const u = uploadStore.get()[id];
  if (!u) return;
  const { state } = u.editor;
  state.doc.descendants((n, pos) => {
    if (n.attrs.upload === id) {
      u.editor.view.dispatch(state.tr.delete(pos, pos + n.nodeSize));
      return false;
    }
    return true;
  });
  if (u.preview) URL.revokeObjectURL(u.preview);
  patch(id, null);
}

/** Registers a file and returns its upload id; call `run` after the node exists. */
function register(editor: Editor, file: File, kind: "image" | "file"): string {
  const id = newId();
  uploadStore.set((all) => ({ ...all, [id]: { file, kind, progress: 0, state: "uploading", editor, preview: kind === "image" ? URL.createObjectURL(file) : undefined } }));
  return id;
}

function accept(files: File[]): File[] {
  const ok = files.filter((f) => f.size <= MAX_UPLOAD);
  if (ok.length < files.length) toast(`Files over ${MAX_UPLOAD / 1024 / 1024} MB can't be attached`, { icon: "triangle-alert" });
  return ok;
}

/** Inserts one block per file (images inline, everything else as attachments) and uploads them. */
export function insertUploads(editor: Editor, files: File[], at?: number, forceKind?: "image" | "file"): boolean {
  const list = accept(files);
  if (!list.length) return files.length > 0;
  const ids: string[] = [];
  const nodes: JSONContent[] = list.map((f) => {
    const kind = forceKind ?? (isImage(f) ? "image" : "file");
    const id = register(editor, f, kind);
    ids.push(id);
    return kind === "image"
      ? { type: "image", attrs: { src: "", alt: f.name.replace(/\.[^.]+$/, ""), caption: "", upload: id } }
      : { type: "fileAttachment", attrs: { name: f.name, size: f.size, mime: f.type, url: "", upload: id } };
  });
  const chain = editor.chain().focus();
  if (at === undefined) chain.insertContent(nodes);
  else chain.insertContentAt(at, nodes);
  chain.run();
  ids.forEach((id) => void run(id));
  return true;
}

/** Uploads into an existing (empty) image node, e.g. the "Upload an image" placeholder. */
export function uploadInto(editor: Editor, file: File, setAttrs: (a: Record<string, unknown>) => void) {
  if (!accept([file]).length) return;
  const id = register(editor, file, isImage(file) ? "image" : "file");
  setAttrs({ upload: id });
  void run(id);
}

/** Uploads one file and returns the result, without a placeholder (e.g. "Replace image"). */
export async function uploadNow(file: File) {
  if (!accept([file]).length) throw new Error("too large");
  return bridge.upload(file);
}
