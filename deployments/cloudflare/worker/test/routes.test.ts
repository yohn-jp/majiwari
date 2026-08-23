import { describe, expect, it } from "vitest";
import { isPublicRoute } from "../src/routes";

describe("isPublicRoute", () => {
  it("routes /health outside OAuth protection", () => {
    expect(isPublicRoute("/health")).toBe("health");
  });

  it("routes /authorize to the authorization flow", () => {
    expect(isPublicRoute("/authorize")).toBe("authorize");
  });

  it("rejects every other path, including /mcp itself, as not-found for the default handler", () => {
    // /mcp never reaches defaultHandler in production: OAuthProvider intercepts
    // apiRoute before falling through here. This asserts the fallback is closed,
    // not open, if that routing ever changes.
    expect(isPublicRoute("/mcp")).toBe("not-found");
    expect(isPublicRoute("/")).toBe("not-found");
    expect(isPublicRoute("/oauth/token")).toBe("not-found");
  });
});
