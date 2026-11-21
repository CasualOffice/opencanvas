import { describe, expect, it } from "vitest";
import { safeHref, safeImageSrc } from "./urls";

describe("safeHref (SEC-20)", () => {
  it("passes web, mail, path and fragment links", () => {
    for (const ok of ["https://x.dev/a?b=1", "http://x", "mailto:a@b.c", "/v1/assets/a_1", "#h"]) expect(safeHref(ok)).toBe(ok);
  });
  it("drops script and data URLs, however they are disguised", () => {
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "java\tscript:alert(1)",
      "\u0000javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "blob:https://x/1",
      "//evil.example/x",
      "/\\evil.example",
      "",
      null,
      undefined,
    ])
      expect(safeHref(bad as string)).toBeUndefined();
  });
});

describe("safeImageSrc (SEC-20)", () => {
  it("allows web, path, blob and raster data images only", () => {
    expect(safeImageSrc("https://cdn/x.png")).toBe("https://cdn/x.png");
    expect(safeImageSrc("/v1/assets/a_1?ticket=t")).toBe("/v1/assets/a_1?ticket=t");
    expect(safeImageSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    for (const bad of ["javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html,x", "file:///etc/passwd"])
      expect(safeImageSrc(bad)).toBeUndefined();
  });
});
