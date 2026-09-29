import { describe, expect, it } from "vitest";
import { startWingdiffServer } from "./server.js";

describe("local server boundary", () => {
  it("rejects a non-loopback bind unless explicitly acknowledged", async () => {
    await expect(startWingdiffServer({ host: "0.0.0.0", environment: {} })).rejects.toThrow(/only binds to loopback/);
  });
});
