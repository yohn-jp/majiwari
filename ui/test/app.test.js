import test from "node:test";
import assert from "node:assert/strict";
import { renderDetail, renderList, renderTargets, renderTools } from "../public/app.js";

/**
 * public/app.js's pure render/escapeHtml functions are exported precisely
 * so this suite can prove, without a DOM, that every adapter-provided
 * string an operator sees -- id, displayName, state, tool name, target
 * displayName, error message -- is HTML-escaped before landing in the
 * innerHTML the shell renders. Treat all of it as untrusted: it comes from
 * an adapter's own manifest/listTools()/health()/targetProvider, not from
 * this codebase.
 */
const XSS_PAYLOAD = '<img src=x onerror=alert(1)>"\'';
const ESCAPED_PAYLOAD = "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;";

test("renderList escapes an untrusted adapter id and displayName", () => {
  const html = renderList([{ id: XSS_PAYLOAD, displayName: XSS_PAYLOAD, state: "running" }]);
  assert.ok(!html.includes(XSS_PAYLOAD), "raw payload must not appear unescaped");
  assert.ok(html.includes(ESCAPED_PAYLOAD));
});

test("renderList escapes an untrusted lifecycle state string", () => {
  const html = renderList([{ id: "fixture-a", state: XSS_PAYLOAD }]);
  assert.ok(!html.includes(XSS_PAYLOAD));
  assert.ok(html.includes(ESCAPED_PAYLOAD));
});

test("renderDetail escapes untrusted identity fields and error/timestamp strings", () => {
  const html = renderDetail({
    id: "fixture-a",
    displayName: XSS_PAYLOAD,
    version: XSS_PAYLOAD,
    transportKind: XSS_PAYLOAD,
    state: "errored",
    error: XSS_PAYLOAD,
    startedAt: XSS_PAYLOAD,
    tools: { ok: true, items: [] },
    health: { ok: false },
    targets: { supported: false, ok: true, items: [] }
  });
  assert.ok(!html.includes(XSS_PAYLOAD), "raw payload must not appear unescaped anywhere in the detail view");
  assert.ok(html.includes(ESCAPED_PAYLOAD));
});

test("renderTools escapes an untrusted tool name and a tool-discovery error message", () => {
  const ok = renderTools({ ok: true, items: [{ name: XSS_PAYLOAD }] });
  assert.ok(!ok.includes(XSS_PAYLOAD));
  assert.ok(ok.includes(ESCAPED_PAYLOAD));

  const failed = renderTools({ ok: false, items: [], error: XSS_PAYLOAD });
  assert.ok(!failed.includes(XSS_PAYLOAD));
  assert.ok(failed.includes(ESCAPED_PAYLOAD));
});

test("renderTargets escapes an untrusted target displayName and a target-provider error message", () => {
  const ok = renderTargets({ supported: true, ok: true, items: [{ id: "t1", displayName: XSS_PAYLOAD }] });
  assert.ok(!ok.includes(XSS_PAYLOAD));
  assert.ok(ok.includes(ESCAPED_PAYLOAD));

  const failed = renderTargets({ supported: true, ok: false, items: [], error: XSS_PAYLOAD });
  assert.ok(!failed.includes(XSS_PAYLOAD));
  assert.ok(failed.includes(ESCAPED_PAYLOAD));
});

test("renderTargets renders a bounded, non-error message for an adapter that never declared the capability", () => {
  const html = renderTargets({ supported: false, ok: true, items: [] });
  assert.match(html, /not supported/i);
  assert.ok(!html.includes("error"));
});
