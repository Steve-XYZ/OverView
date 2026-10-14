import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { it } from "node:test";
import { createContext, runInContext } from "node:vm";

type Selection = { days: number } | { from: string; to: string };

function dashboard() {
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  const rendered: unknown[] = [];
  const elements = new Map<string, { textContent: string; hidden: boolean; setAttribute(name: string, value: string): void }>();
  const attributes = new Map<string, string>();
  const context = createContext({
    URLSearchParams, Error, rendered,
    window: { location: { hash: "" } },
    document: {
      querySelectorAll: () => [],
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, {
          textContent: "", hidden: true,
          setAttribute: (name, value) => { attributes.set(`${id}:${name}`, value); },
        });
        return elements.get(id);
      },
    },
    fetch: () => {
      const request = Promise.withResolvers<Response>();
      requests.push(request);
      return request.promise;
    },
  });
  const source = stripTypeScriptTypes(readFileSync(new URL("../src/web/app.ts", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "")
    .replace(/^export /gm, "")
    .replace("void main();", "");
  // Run the real loader without bootstrapping the page or drawing its charts.
  runInContext(`${source}\nrender = (summary) => rendered.push(summary);`, context);
  return {
    load: runInContext("load", context) as (selection: Selection) => Promise<void>,
    requests, rendered, elements, attributes,
    state: () => JSON.parse(runInContext("JSON.stringify({ selection, currentSummary, hash: window.location.hash })", context) as string) as {
      selection: Selection; currentSummary: unknown; hash: string;
    },
  };
}

it("keeps the newest range when an older successful request finishes last", async () => {
  const page = dashboard();
  const old = page.load({ days: 7 });
  const current = page.load({ from: "2026-09-01", to: "2026-09-24" });
  page.requests[1]!.resolve(Response.json({ marker: "current" }));
  await current;
  page.requests[0]!.resolve(Response.json({ marker: "old" }));
  await old;
  assert.deepEqual(page.rendered, [{ marker: "current" }]);
  assert.deepEqual(page.state(), {
    selection: { from: "2026-09-01", to: "2026-09-24" },
    currentSummary: { marker: "current" }, hash: "from=2026-09-01&to=2026-09-24",
  });
});

it("ignores a superseded response whose JSON body finishes after the new range", async () => {
  const page = dashboard();
  const body = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  const old = page.load({ days: 7 });
  page.requests[0]!.resolve({ ok: true, status: 200, json: () => { started.resolve(); return body.promise; } } as Response);
  await started.promise;
  const current = page.load({ days: 90 });
  page.requests[1]!.resolve(Response.json({ marker: "current" }));
  await current;
  body.resolve({ marker: "old" });
  await old;
  assert.deepEqual(page.rendered, [{ marker: "current" }]);
  assert.deepEqual(page.state().selection, { days: 90 });
});

for (const outcome of ["empty", "http-error", "network-error"] as const) {
  it(`ignores a stale ${outcome} without clearing the current request's loading state`, async () => {
    const page = dashboard();
    const old = page.load({ days: 7 });
    const current = page.load({ days: 90 });
    if (outcome === "network-error") page.requests[0]!.reject(new Error("old failure"));
    else page.requests[0]!.resolve(Response.json({ error: "old failure" }, { status: outcome === "empty" ? 404 : 500 }));
    await old;
    assert.equal(page.attributes.get("main:aria-busy"), "true");
    assert.equal(page.elements.get("warnings")?.textContent ?? "", "");
    assert.equal(page.elements.get("account-link")?.hidden ?? true, true);
    page.requests[1]!.resolve(Response.json({ marker: "current" }));
    await current;
    assert.deepEqual(page.rendered, [{ marker: "current" }]);
    assert.equal(page.attributes.get("main:aria-busy"), "false");
  });
}

it("still displays an error for the current request and clears its loading state", async () => {
  const page = dashboard();
  const current = page.load({ days: 90 });
  page.requests[0]!.resolve(Response.json({ error: "current failure" }, { status: 500 }));
  await current;
  assert.equal(page.elements.get("warnings")?.textContent, "Could not load the summary: current failure");
  assert.equal(page.elements.get("load-error")?.textContent, "Could not load the summary: current failure");
  assert.equal(page.elements.get("load-error")?.hidden, false);
  assert.equal(page.attributes.get("main:aria-busy"), "false");
});

it("ignores an old error whose body finishes after a newer successful response", async () => {
  const page = dashboard();
  const body = Promise.withResolvers<unknown>();
  const started = Promise.withResolvers<void>();
  const old = page.load({ days: 7 });
  page.requests[0]!.resolve({ ok: false, status: 500, json: () => { started.resolve(); return body.promise; } } as Response);
  await started.promise;
  const current = page.load({ days: 90 });
  page.requests[1]!.resolve(Response.json({ marker: "current" }));
  await current;
  body.resolve({ error: "old failure" });
  await old;
  assert.deepEqual(page.rendered, [{ marker: "current" }]);
  assert.equal(page.elements.get("warnings")?.textContent ?? "", "");
});

it("still shows the first-publication state for the current request", async () => {
  const page = dashboard();
  const current = page.load({ days: 30 });
  page.requests[0]!.resolve(Response.json({}, { status: 404 }));
  await current;
  assert.match(page.elements.get("scope-line")?.textContent ?? "", /Nothing published yet/);
  assert.equal(page.elements.get("account-link")?.hidden, false);
  assert.equal(page.elements.get("empty-state")?.hidden, false);
  assert.equal(page.elements.get("main")?.hidden, true);
  assert.equal(page.attributes.get("main:aria-busy"), "false");
});
