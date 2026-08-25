import { describe, expect, it } from "vitest";
import { classifyRoute } from "../src/routes";

describe("classifyRoute", () => {
  it("routes /health outside Access protection", () => {
    expect(classifyRoute("/health")).toBe("health");
  });

  it("routes /mcp to the Access-protected gateway proxy", () => {
    expect(classifyRoute("/mcp")).toBe("mcp");
  });

  it("routes /mcp/:adapterId to the Access-protected gateway proxy", () => {
    expect(classifyRoute("/mcp/fixture-a")).toBe("mcp");
    expect(classifyRoute("/mcp/ocr")).toBe("mcp");
  });

  it("rejects every other path as not-found, including retired OAuth endpoints and nested adapter paths", () => {
    expect(classifyRoute("/")).toBe("not-found");
    expect(classifyRoute("/authorize")).toBe("not-found");
    expect(classifyRoute("/oauth/token")).toBe("not-found");
    expect(classifyRoute("/oauth/register")).toBe("not-found");
    expect(classifyRoute("/mcp/")).toBe("not-found");
    expect(classifyRoute("/mcp/fixture-a/extra")).toBe("not-found");
  });
});
