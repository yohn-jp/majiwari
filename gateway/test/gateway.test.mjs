import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../bin/gateway.mjs";

test("uses the default host and port", () => {
  assert.deepEqual(parseArgs([], {}), {
    command: undefined,
    args: [],
    port: "8787",
    host: "127.0.0.1"
  });
});

test("allows the host and port to be overridden", () => {
  assert.deepEqual(parseArgs(["--port", "9000", "--host", "0.0.0.0", "server", "--flag"], {}), {
    command: "server",
    args: ["--flag"],
    port: "9000",
    host: "0.0.0.0"
  });
});

test("uses -- to separate the target command from its arguments", () => {
  assert.deepEqual(parseArgs(["--port", "9000", "--", "node", "server.js", "--flag"], {}), {
    command: "node",
    args: ["server.js", "--flag"],
    port: "9000",
    host: "127.0.0.1"
  });
});

test("falls back to MAJIWARI target environment variables", () => {
  assert.deepEqual(parseArgs([], {
    MAJIWARI_GATEWAY_PORT: "9999",
    MAJIWARI_TARGET_COMMAND: "node",
    MAJIWARI_TARGET_ARGS: "server.js --flag"
  }), {
    command: "node",
    args: ["server.js", "--flag"],
    port: "9999",
    host: "127.0.0.1"
  });
});

test("leaves command undefined when neither CLI nor environment specifies one", () => {
  assert.equal(parseArgs([], {}).command, undefined);
});
