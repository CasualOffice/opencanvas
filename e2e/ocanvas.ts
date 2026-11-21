// Just enough of a zip reader to look inside the .ocanvas files the host stored.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { HOST, HOST_RELOAD } from "./env";

export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data) : Buffer.alloc(0));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** `document.json` of the host's stored copy of a file, as text (null when the host has no bytes yet). */
export function storedDocument(fileId: string, host = HOST): string | null {
  const dir = host === HOST_RELOAD ? "host-reload" : "host";
  const f = path.join(process.env.E2E_TMP!, dir, "files", `${fileId}.ocanvas`);
  if (!fs.existsSync(f)) return null;
  return unzip(fs.readFileSync(f)).get("document.json")?.toString("utf8") ?? null;
}
