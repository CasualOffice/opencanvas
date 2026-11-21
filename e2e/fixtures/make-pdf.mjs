// Writes a tiny 3-page PDF (one heading per page, Helvetica, US Letter) for the file preview
// tests and the demo canvas:  node e2e/fixtures/make-pdf.mjs <out.pdf>
import fs from "node:fs";

const pages = [
  ["Session design brief", "Page one: goals and scope."],
  ["Architecture", "Page two: rooms, autosave and the host contract."],
  ["Open questions", "Page three: what we still need to decide."],
];
const objs = [];
const add = (s) => (objs.push(s), objs.length);
const catalog = add(""); // filled below
const pagesObj = add("");
const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
const kids = [];
pages.forEach(([title, line], i) => {
  const text = `BT /F1 28 Tf 72 700 Td (${title}) Tj ET\nBT /F1 14 Tf 72 660 Td (${line}) Tj ET\nBT /F1 11 Tf 72 60 Td (${i + 1} / ${pages.length}) Tj ET\n0.2 0.35 0.84 RG 4 w 72 640 m 300 640 l S`;
  const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
});
objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

let out = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(out.length);
  out += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(process.argv[2] ?? "three-pages.pdf", out, "latin1");
