import { describe, expect, test } from "bun:test";
import { loadPlugins, plugins } from "./plugins";

// Settings → Plugins: a plugin switched off on the server is not registered
// at all on this screen (index.tsx passes the server's disabled list).
// The stub plugins carry nothing, so leaving them registered (bun shares
// one module registry across test files) affects no other test.
describe("loadPlugins", () => {
  test("registers every plugin but the switched-off ones", () => {
    loadPlugins(
      {
        "a/frontend/index.ts": { default: { id: "test-on" } },
        "b/frontend/index.ts": { default: { id: "test-off" } },
      },
      new Set(["test-off"]),
    );
    const ids = plugins().map((p) => p.id);
    expect(ids).toContain("test-on");
    expect(ids).not.toContain("test-off");
  });
});
