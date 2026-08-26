import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AdapterRegistry, AdapterState, TargetProviderError } from "@majiwari/registry";
import { createRegistryGateway } from "@majiwari/gateway";
import { ADAPTER_ID, createManifest } from "../src/manifest.js";
import { createLocalTargetProvider } from "../src/local-target-provider.js";

const execFileAsync = promisify(execFile);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function createGitRepo(prefix, content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(path.join(dir, "file.txt"), content);
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, headCommit: stdout.trim() };
}

/**
 * A minimal fake `ocr` on PATH that echoes back which repository it was
 * actually invoked against (via its own `--repo` argument) inside its JSON
 * output, so tests can prove a managed tool call ran OCR against the
 * resolved target for *that* call -- without depending on the real `ocr`
 * CLI being installed wherever this suite runs.
 */
function withFakeOcrOnPath(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fake-marker-"));
  const fakeOcr = path.join(dir, "ocr");
  fs.writeFileSync(
    fakeOcr,
    [
      "#!/bin/sh",
      'repo=""',
      'prev=""',
      'for arg in "$@"; do',
      '  if [ "$prev" = "--repo" ]; then repo="$arg"; fi',
      '  prev="$arg"',
      "done",
      'marker=$(basename "$repo")',
      'if [ "$1" = "delegate" ] && [ "$2" = "preview" ]; then',
      '  echo "{\\"schema_version\\":\\"1\\",\\"reviewable_files\\":[{\\"path\\":\\"file.txt\\",\\"repo_marker\\":\\"$marker\\"}]}"',
      'elif [ "$1" = "delegate" ] && [ "$2" = "rule" ]; then',
      '  echo "{\\"repo_marker\\":\\"$marker\\"}"',
      'elif [ "$1" = "rules" ] && [ "$2" = "check" ]; then',
      '  echo "rule-for-$marker"',
      "else",
      '  echo "{}"',
      "fi"
    ].join("\n") + "\n",
    { mode: 0o755 }
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  return (async () => {
    try {
      return await fn();
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

async function withTwoTargetRepos(fn) {
  const a = await createGitRepo("ocr-managed-a-", "hello from target-a\n");
  const b = await createGitRepo("ocr-managed-b-", "hello from target-b\n");
  try {
    await fn(a, b);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
}

async function startManaged(provider) {
  const registry = new AdapterRegistry();
  registry.register(createManifest({ targetProvider: provider }));
  const status = await registry.start(ADAPTER_ID);
  assert.equal(status.state, AdapterState.RUNNING, status.error);
  return { registry, mcpClient: registry.resource(ADAPTER_ID).mcpClient };
}

test("one resident OCR adapter serves two distinct targetIds/worktrees without restart", async () => {
  await withTwoTargetRepos(async (a, b) => {
    const provider = createLocalTargetProvider([
      { id: "target-a", repoRoot: a.dir },
      { id: "target-b", repoRoot: b.dir }
    ]);
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const readA = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-a" } });
      const readB = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-b" } });
      assert.equal(readA.structuredContent.content, "hello from target-a\n");
      assert.equal(readB.structuredContent.content, "hello from target-b\n");

      // Same resident adapter, same registry entry, never restarted between calls.
      assert.equal(registry.get(ADAPTER_ID).state, AdapterState.RUNNING);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("interleaved/concurrent workflows use only their own supplied target with no cross-talk", async () => {
  await withTwoTargetRepos(async (a, b) => {
    await writeFile(path.join(b.dir, "file.txt"), "hello from target-b (workspace edit)\n");

    const provider = createLocalTargetProvider([
      { id: "target-a", repoRoot: a.dir },
      { id: "target-b", repoRoot: b.dir }
    ]);
    const { registry, mcpClient } = await startManaged(provider);

    async function workflowA() {
      const search = await mcpClient.callTool({ name: "repo_search", arguments: { query: "target-a", targetId: "target-a" } });
      const diff = await mcpClient.callTool({
        name: "repo_diff",
        arguments: { mode: "commit", path: "file.txt", commit: a.headCommit, targetId: "target-a" }
      });
      const read = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-a" } });
      return { search, diff, read };
    }

    async function workflowB() {
      const search = await mcpClient.callTool({ name: "repo_search", arguments: { query: "target-b", targetId: "target-b" } });
      const diff = await mcpClient.callTool({
        name: "repo_diff",
        arguments: { mode: "workspace", path: "file.txt", workspace_source: "tracked", targetId: "target-b" }
      });
      const read = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-b" } });
      return { search, diff, read };
    }

    try {
      const [resultsA, resultsB] = await Promise.all([workflowA(), workflowB()]);

      assert.equal(resultsA.search.structuredContent.found, true);
      assert.match(resultsA.search.structuredContent.matches, /target-a/);
      assert.doesNotMatch(resultsA.search.structuredContent.matches, /target-b/);
      assert.match(resultsA.diff.structuredContent.content, /hello from target-a/);
      assert.equal(resultsA.read.structuredContent.content, "hello from target-a\n");

      assert.equal(resultsB.search.structuredContent.found, true);
      assert.match(resultsB.search.structuredContent.matches, /target-b/);
      assert.doesNotMatch(resultsB.search.structuredContent.matches, /target-a/);
      assert.match(resultsB.diff.structuredContent.content, /workspace edit/);
      assert.equal(resultsB.read.structuredContent.content, "hello from target-b (workspace edit)\n");
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("preview/rules/rules-check resolve only their own supplied target", async () => {
  await withFakeOcrOnPath(async () => {
    await withTwoTargetRepos(async (a, b) => {
      const provider = createLocalTargetProvider([
        { id: "target-a", repoRoot: a.dir },
        { id: "target-b", repoRoot: b.dir }
      ]);
      const { registry, mcpClient } = await startManaged(provider);
      try {
        const previewA = await mcpClient.callTool({ name: "ocr_delegate_preview", arguments: { targetId: "target-a" } });
        const previewB = await mcpClient.callTool({ name: "ocr_delegate_preview", arguments: { targetId: "target-b" } });
        assert.equal(previewA.structuredContent.preview.reviewable_files[0].repo_marker, path.basename(a.dir));
        assert.equal(previewB.structuredContent.preview.reviewable_files[0].repo_marker, path.basename(b.dir));

        const rulesA = await mcpClient.callTool({ name: "ocr_delegate_rules", arguments: { paths: ["file.txt"], targetId: "target-a" } });
        assert.equal(rulesA.structuredContent.rules.repo_marker, path.basename(a.dir));

        const checkB = await mcpClient.callTool({ name: "ocr_rules_check", arguments: { path: "file.txt", targetId: "target-b" } });
        assert.equal(checkB.structuredContent.output.trim(), `rule-for-${path.basename(b.dir)}`);
      } finally {
        await registry.stop(ADAPTER_ID);
      }
    });
  });
});

const WORKSPACE_TOOLS = [
  { name: "ocr_delegate_preview", arguments: {} },
  { name: "ocr_delegate_rules", arguments: { paths: ["file.txt"] } },
  { name: "scan_delegate_preview", arguments: {} },
  { name: "ocr_rules_check", arguments: { path: "file.txt" } },
  { name: "repo_diff", arguments: { mode: "workspace", path: "file.txt", workspace_source: "tracked" } },
  { name: "repo_read_file", arguments: { path: "file.txt" } },
  { name: "repo_search", arguments: { query: "hello" } }
];

test("managed omission of targetId fails every workspace-sensitive tool before any side effect", async () => {
  await withTwoTargetRepos(async (a) => {
    let resolveCalls = 0;
    const inner = createLocalTargetProvider([{ id: "target-a", repoRoot: a.dir }]);
    const countingProvider = {
      ...inner,
      resolve: async (id) => {
        resolveCalls += 1;
        return inner.resolve(id);
      }
    };
    const { registry, mcpClient } = await startManaged(countingProvider);
    try {
      for (const tool of WORKSPACE_TOOLS) {
        const response = await mcpClient.callTool({ name: tool.name, arguments: tool.arguments });
        assert.equal(response.isError, true, `${tool.name} should fail without targetId`);
        const text = response.content.map((entry) => entry.text ?? "").join(" ");
        assert.match(text, /targetId is required/);
      }
      assert.equal(resolveCalls, 0, "provider.resolve() must never be called when targetId is omitted");
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("unknown, invalidated, and path-shaped targets fail before OCR/git/filesystem access", async () => {
  await withTwoTargetRepos(async (a) => {
    const provider = createLocalTargetProvider([{ id: "target-a", repoRoot: a.dir }]);
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const unknown = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "no-such-target" } });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content[0].text, /no target registered/);

      const traversal = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "../../etc/passwd" } });
      assert.equal(traversal.isError, true);
      assert.match(traversal.content[0].text, /not a valid opaque target identifier/);

      await registry.invalidateTarget(ADAPTER_ID, "target-a");
      const unavailable = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-a" } });
      assert.equal(unavailable.isError, true);
      assert.match(unavailable.content[0].text, /unavailable/);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("never falls back to a startup repository or another target when the managed target is invalid", async () => {
  await withTwoTargetRepos(async (a, b) => {
    const provider = createLocalTargetProvider([
      { id: "target-a", repoRoot: a.dir },
      { id: "target-b", repoRoot: b.dir }
    ]);
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const missing = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "no-such-target" } });
      assert.equal(missing.isError, true);
      // A fallback bug would silently read target-a or target-b's content instead of failing.
      const text = JSON.stringify(missing.content);
      assert.ok(!text.includes("hello from target-a"));
      assert.ok(!text.includes("hello from target-b"));
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

function malformedDescriptorProvider(descriptor) {
  return {
    schemaVersion: "1",
    list: async () => [],
    get: async () => {
      throw new Error("not used in this test");
    },
    resolve: async () => ({ id: "bad-target", descriptor }),
    invalidate: async () => ({ id: "bad-target", invalidated: true })
  };
}

test("malformed resolved descriptors fail closed without touching git/OCR/filesystem", async () => {
  for (const descriptor of [undefined, null, "just-a-string", ["/abs/path"], {}, { repoRoot: "relative/path" }, { repoRoot: 123 }]) {
    const { registry, mcpClient } = await startManaged(malformedDescriptorProvider(descriptor));
    try {
      const response = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "bad-target" } });
      assert.equal(response.isError, true, `descriptor ${JSON.stringify(descriptor)} must fail closed`);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  }
});

function providerThrowing(error) {
  return {
    schemaVersion: "1",
    list: async () => [],
    get: async () => {
      throw new Error("not used in this test");
    },
    resolve: async () => {
      throw error;
    },
    invalidate: async () => ({ id: "bad-target", invalidated: true })
  };
}

test("unexpected/custom provider failures from resolve() are normalized and never forwarded to MCP unchanged", async () => {
  const secretPath = "/abs/secret/worktree-should-not-leak";

  // A base TargetProviderError (or any custom subclass a provider is free to
  // throw) is *not* one of the two exact, registry-defined shapes
  // (TargetNotFoundError/TargetUnavailableError) whose message is guaranteed
  // to embed nothing but the caller's own targetId -- so it must never reach
  // an MCP response unchanged, even though it is "a TargetProviderError".
  class CustomProviderFailure extends TargetProviderError {
    constructor(message) {
      super(message);
      this.name = "CustomProviderFailure";
    }
  }

  for (const error of [
    new TargetProviderError(`resolve failed while inspecting worktree ${secretPath}`),
    new CustomProviderFailure(`worktree ${secretPath} is corrupted`),
    new Error(`unexpected failure touching ${secretPath}`)
  ]) {
    const { registry, mcpClient } = await startManaged(providerThrowing(error));
    try {
      const response = await mcpClient.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "any-target" } });
      assert.equal(response.isError, true);
      const text = JSON.stringify(response.content);
      assert.ok(!text.includes(secretPath), `must not leak the provider's internal path for ${error.constructor.name}`);
      assert.ok(!text.includes("corrupted") && !text.includes("inspecting"), `must not forward the provider's raw message for ${error.constructor.name}`);
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  }
});

test("no resolved absolute worktree path leaks through MCP errors, registry targets, or health", async () => {
  await withTwoTargetRepos(async (a, b) => {
    const provider = createLocalTargetProvider([
      { id: "target-a", repoRoot: a.dir },
      { id: "target-b", repoRoot: b.dir }
    ]);
    const { registry, mcpClient } = await startManaged(provider);
    try {
      const listed = await registry.listTargets(ADAPTER_ID);
      assert.ok(!JSON.stringify(listed).includes(a.dir));
      assert.ok(!JSON.stringify(listed).includes(b.dir));

      const got = await registry.getTarget(ADAPTER_ID, "target-a");
      assert.ok(!JSON.stringify(got).includes(a.dir));

      const health = await registry.health(ADAPTER_ID);
      assert.ok(!("repo_root" in (health.detail ?? {})));
      assert.ok(!JSON.stringify(health).includes(a.dir));
      assert.ok(!JSON.stringify(health).includes(b.dir));

      // A command failure (unknown tool argument reaching `ocr`/`git`) must not
      // surface the resolved repository root in its MCP error content either.
      const failed = await mcpClient.callTool({ name: "repo_diff", arguments: { mode: "commit", path: "file.txt", commit: "not-a-real-ref", targetId: "target-a" } });
      assert.equal(failed.isError, true);
      const failedText = JSON.stringify(failed.content);
      assert.ok(!failedText.includes(a.dir));
    } finally {
      await registry.stop(ADAPTER_ID);
    }
  });
});

test("one resident OCR endpoint (/mcp/open-code-review) switches between two managed targets over real MCP/HTTP, no restart", async () => {
  await withTwoTargetRepos(async (a, b) => {
    const provider = createLocalTargetProvider([
      { id: "target-a", repoRoot: a.dir },
      { id: "target-b", repoRoot: b.dir }
    ]);

    const registry = new AdapterRegistry();
    const port = await getFreePort();
    const gateway = await createRegistryGateway({ registry, host: "127.0.0.1", port });
    let client;
    try {
      const published = await gateway.publish(createManifest({ targetProvider: provider }));
      assert.equal(published.id, ADAPTER_ID);
      assert.equal(published.state, AdapterState.RUNNING);

      client = new Client({ name: "ocr-managed-gateway-smoke", version: "1.0.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${ADAPTER_ID}`)));

      const readA = await client.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-a" } });
      assert.equal(readA.structuredContent.content, "hello from target-a\n");

      // Same published endpoint, same registry entry, same running adapter --
      // switching targets never restarts it.
      const readB = await client.callTool({ name: "repo_read_file", arguments: { path: "file.txt", targetId: "target-b" } });
      assert.equal(readB.structuredContent.content, "hello from target-b\n");
      assert.equal(registry.get(ADAPTER_ID).state, AdapterState.RUNNING);
    } finally {
      await client?.close();
      await gateway.close();
    }
  });
});

test("standalone/default manifest accepts and ignores targetId, preserving current single-repository behavior", async () => {
  const registry = new AdapterRegistry();
  registry.register(createManifest());
  await registry.start(ADAPTER_ID);
  try {
    const withoutTargetId = await registry.resource(ADAPTER_ID).mcpClient.callTool({ name: "repo_search", arguments: { query: "majiwari", paths: ["package.json"] } });
    const withTargetId = await registry.resource(ADAPTER_ID).mcpClient.callTool({ name: "repo_search", arguments: { query: "majiwari", paths: ["package.json"], targetId: "ignored-in-standalone-mode" } });
    assert.equal(withoutTargetId.isError, undefined);
    assert.equal(withTargetId.isError, undefined);
    assert.deepEqual(withTargetId.structuredContent, withoutTargetId.structuredContent);
  } finally {
    await registry.stop(ADAPTER_ID);
  }
});
