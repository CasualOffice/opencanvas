import { afterEach, describe, expect, it } from "vitest";
import { resolveAsset, setAssetTicket } from "./assets";

describe("resolveAsset", () => {
  afterEach(() => setAssetTicket(null));

  it("adds this viewer's ticket to room-served assets only", () => {
    setAssetTicket("T 1");
    expect(resolveAsset("/v1/assets/a_1")).toBe("/v1/assets/a_1?ticket=T%201");
    expect(resolveAsset("https://host.example/assets/a_1")).toBe("https://host.example/assets/a_1");
    expect(resolveAsset("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("never doubles a ticket and is a no-op before a session exists", () => {
    expect(resolveAsset("/v1/assets/a_1")).toBe("/v1/assets/a_1");
    setAssetTicket("T");
    expect(resolveAsset("/v1/assets/a_1?ticket=X")).toBe("/v1/assets/a_1?ticket=X");
    expect(resolveAsset(undefined)).toBeUndefined();
  });
});
