import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ResidentConfigError, parseResidentConfig } from "../src/config.js";
import { createResidentRuntime } from "../src/runtime.js";

const REPO = path.resolve("/private/majiwari/resident-target");

test("version-1 resident config normalizes defaults and accepts only explicit absolute repos", () => {
  assert.deepEqual(
    parseResidentConfig({
      version: 1,
      adapters: {
        "open-code-review": { enabled: true, repo: REPO },
        inari: { enabled: false }
      }
    }),
    {
      version: 1,
      port: 8787,
      adapters: {
        "open-code-review": { enabled: true, repo: REPO },
        inari: { enabled: false }
      }
    }
  );
});

test("closed config rejects unsupported fields, IDs, paths, ports, and versions without echoing values", () => {
  const invalidConfigs = [
    { version: 2, adapters: {} },
    { version: 1, command: "node", adapters: {} },
    { version: 1, adapters: { fixture: { enabled: true, repo: REPO } } },
    { version: 1, adapters: { inari: { enabled: true, repo: "relative/repository" } } },
    { version: 1, adapters: { inari: { enabled: true, repo: "https://example.invalid/repo" } } },
    { version: 1, adapters: { inari: { enabled: true, repo: REPO, command: "node" } } },
    { version: 1, adapters: { inari: { enabled: true, repo: REPO, args: [] } } },
    { version: 1, adapters: { inari: { enabled: true, repo: REPO, env: {} } } },
    { version: 1, adapters: { inari: { enabled: true, repo: REPO, url: "http://127.0.0.1" } } },
    { version: 1, adapters: { inari: { enabled: true, repo: REPO, module: "./plugin.js" } } },
    { version: 1, port: 0, adapters: {} },
    { version: 1, port: 65536, adapters: {} },
    { version: 1, port: "8787", adapters: {} }
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => parseResidentConfig(config),
      (error) => error instanceof ResidentConfigError && !error.message.includes(REPO)
    );
  }
});

test("version-1 resident config accepts a static 'targets' list as an alternative to a single repo", () => {
  assert.deepEqual(
    parseResidentConfig({
      version: 1,
      adapters: {
        "open-code-review": {
          enabled: true,
          targets: [
            { id: "target-a", repo: REPO },
            { id: "target-b", repo: `${REPO}-b` }
          ]
        }
      }
    }),
    {
      version: 1,
      port: 8787,
      adapters: {
        "open-code-review": {
          enabled: true,
          targets: [
            { id: "target-a", repo: REPO },
            { id: "target-b", repo: `${REPO}-b` }
          ]
        }
      }
    }
  );
});

test("'targets' is rejected when empty, duplicated, path-shaped, mixed with repo, or pointing at an unsafe/relative path", () => {
  const invalidConfigs = [
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [] } } },
    {
      version: 1,
      adapters: {
        "open-code-review": {
          enabled: true,
          targets: [
            { id: "same", repo: REPO },
            { id: "same", repo: `${REPO}-b` }
          ]
        }
      }
    },
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [{ id: "../../etc/passwd", repo: REPO }] } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, repo: REPO, targets: [{ id: "a", repo: REPO }] } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [{ id: "a", repo: "relative/repository" }] } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [{ id: "a" }] } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [{ repo: REPO }] } } }
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => parseResidentConfig(config),
      (error) => error instanceof ResidentConfigError && !error.message.includes(REPO)
    );
  }
});

test("version-1 resident config accepts a 'mottainai' provider config as an alternative to repo/targets", () => {
  assert.deepEqual(
    parseResidentConfig({
      version: 1,
      adapters: {
        "open-code-review": { enabled: true, mottainai: { command: "mottainai", cwd: REPO } }
      }
    }),
    {
      version: 1,
      port: 8787,
      adapters: {
        "open-code-review": { enabled: true, mottainai: { command: "mottainai", cwd: REPO } }
      }
    }
  );

  // command/cwd are both optional -- an empty options object is valid.
  assert.deepEqual(
    parseResidentConfig({
      version: 1,
      adapters: { "open-code-review": { enabled: true, mottainai: {} } }
    }).adapters["open-code-review"],
    { enabled: true, mottainai: {} }
  );
});

test("'mottainai' is rejected when mixed with repo/targets, or given an unsafe/relative/unsupported field", () => {
  const invalidConfigs = [
    { version: 1, adapters: { "open-code-review": { enabled: true, repo: REPO, mottainai: {} } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, targets: [{ id: "a", repo: REPO }], mottainai: {} } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, mottainai: { cwd: "relative/path" } } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, mottainai: { command: "" } } } },
    { version: 1, adapters: { "open-code-review": { enabled: true, mottainai: { url: "http://127.0.0.1" } } } }
  ];

  for (const config of invalidConfigs) {
    assert.throws(
      () => parseResidentConfig(config),
      (error) => error instanceof ResidentConfigError && !error.message.includes(REPO)
    );
  }
});

test("invalid config is rejected before resident startup side effects", () => {
  let serverFactoryCalls = 0;
  let registryFactoryCalls = 0;
  let catalogFactoryCalls = 0;

  assert.throws(
    () =>
      createResidentRuntime(
        { version: 1, adapters: { inari: { enabled: true, repo: "not-absolute" } } },
        {
          serverFactory: () => {
            serverFactoryCalls += 1;
          },
          registryFactory: () => {
            registryFactoryCalls += 1;
          },
          catalog: {
            inari: () => {
              catalogFactoryCalls += 1;
            }
          }
        }
      ),
    ResidentConfigError
  );

  assert.equal(serverFactoryCalls, 0);
  assert.equal(registryFactoryCalls, 0);
  assert.equal(catalogFactoryCalls, 0);
});
