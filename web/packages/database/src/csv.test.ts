import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

// SEC-19 (docs/18): a cell that starts with = + - @ (or tab / CR) is a formula in Excel,
// LibreOffice and Sheets. Exported CSV must open as text, not run `=HYPERLINK(...)` / DDE.
describe("CSV export formula injection", () => {
  it("neutralises formula-leading cells", () => {
    for (const evil of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "=HYPERLINK(\"https://evil\",\"x\")"]) {
      const out = csvCell(evil);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted.startsWith("'"), `${JSON.stringify(evil)} -> ${out}`).toBe(true);
    }
  });

  it("keeps plain numbers and ordinary text as they are", () => {
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell("+3.25")).toBe("+3.25");
    expect(csvCell("-1,234.5")).toBe('"-1,234.5"');
    expect(csvCell("hello")).toBe("hello");
    expect(csvCell("a=b")).toBe("a=b");
    expect(toCsv([["Name", "Score"], ["=evil()", "-7"]])).toBe("Name,Score\n'=evil(),-7");
  });
});
