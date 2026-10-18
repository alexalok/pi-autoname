import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../extensions/lib.ts";

let instance = 0;
async function setup(t: any, options: {
  user?: string;
  name?: string;
  config?: Record<string, unknown>;
  complete?: (model: any, context: any, options: any) => Promise<any>;
} = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-autoname-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configDir = join(home, ".pi", "agent");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "pi-autoname.json"), JSON.stringify({ ...DEFAULT_CONFIG, ...options.config }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  let extension: any;
  try {
    extension = (await import(`../extensions/index.ts?test=${++instance}`)).default;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const markers: any[] = [];
  const notifications: any[] = [];
  const calls: any[] = [];
  let name = options.name;
  const branch: any[] = [
    { type: "message", message: { role: "user", content: options.user ?? "修复数据库连接" } },
    { type: "message", message: { role: "assistant", content: "开始检查" } },
  ];
  const model = { provider: "fixture", id: "keyless" };
  const ctx = {
    model,
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      // No getApiKeyAndHeaders: authentication belongs to the host runtime.
      streamSimple: (model: any, context: any, requestOptions: any) => ({ result: async () => {
        calls.push({ model, context, options: requestOptions });
        return options.complete ? options.complete(model, context, requestOptions) : { content: [{ type: "text", text: "数据库连接修复" }] };
      } }),
    },
    sessionManager: { getBranch: () => branch, getSessionFile: () => undefined },
    ui: { notify: (...args: any[]) => notifications.push(args) },
  };
  const pi = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerCommand: (command: string, definition: any) => commands.set(command, definition),
    events: { emit: () => {} },
    getSessionName: () => name,
    setSessionName: (next: string) => {
      name = next;
      handlers.get("session_info_changed")?.({ name: next }, ctx);
    },
    appendEntry: (customType: string, data: any) => {
      markers.push(data);
      branch.push({ type: "custom", customType, data });
    },
  };
  extension(pi);
  await handlers.get("session_start")({}, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  return {
    calls, markers, notifications, ctx,
    get name() { return name; },
    manual: () => commands.get("autoname").handler("", ctx),
    settled: async () => {
      handlers.get("agent_settled")({}, ctx);
      for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    },
    reload: () => handlers.get("session_start")({}, ctx),
    shutdown: () => handlers.get("session_shutdown")({}, ctx),
  };
}

describe("extension naming integration", () => {
  it("automatically names through the runtime without requiring an API key", async t => {
    const test = await setup(t);
    await test.settled();
    assert.equal(test.name, "数据库连接修复");
    assert.equal(test.calls.length, 1);
    assert.equal(test.calls[0].options.maxTokens, 64);
    assert.ok(test.calls[0].options.signal instanceof AbortSignal);
    assert.equal(test.markers[0].source, "ai");
    await test.reload();
    await test.settled();
    assert.equal(test.calls.length, 1, "reload must restore the cooldown marker");
  });

  it("redacts JSON user content and the current name in the final model request", async t => {
    const test = await setup(t, {
      user: '{"password":"demo123","API_KEY":"fixture-key-value"}',
      name: '{"token":"fixture-title-token"}',
    });
    await test.manual();
    const prompt = test.calls[0].context.messages[0].content[0].text;
    assert.doesNotMatch(prompt, /demo123|fixture-key-value|fixture-title-token/);
    assert.match(prompt, /REDACTED/);
    assert.equal(test.name, "数据库连接修复");
  });

  it("does not persist a JSON secret as a fallback name after model failure", async t => {
    const test = await setup(t, { user: '{"password":"demo123"}', complete: async () => { throw new Error("fixture failure"); } });
    await test.manual();
    assert.equal(test.name, undefined);
    assert.deepEqual(test.markers, []);
    assert.equal(test.notifications[0][1], "warning");
  });

  it("tries configured fallbacks through the same runtime", async t => {
    const test = await setup(t, {
      config: { model: "fixture/primary", fallbackModels: ["fixture/backup"] },
      complete: async model => {
        if (model.id === "primary") throw new Error("fixture authentication failure");
        return { content: [{ type: "text", text: "回退模型命名" }] };
      },
    });
    await test.manual();
    assert.deepEqual(test.calls.map(call => call.model.id), ["primary", "backup"]);
    assert.equal(test.name, "回退模型命名");
  });

  it("preserves clean local fallback naming when every model fails", async t => {
    const test = await setup(t, { complete: async () => { throw new Error("fixture failure"); } });
    await test.manual();
    assert.equal(test.name, "修复数据库连接");
    assert.equal(test.markers[0].source, "fallback");
  });

  it("bounds pending runtime work to 12-second attempts and a shared 30-second budget", async t => {
    const test = await setup(t, {
      config: { model: "fixture/primary", fallbackModels: ["fixture/backup"] },
      complete: async (_model, _context, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      }),
    });
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    const pending = test.manual();
    assert.equal(test.calls.length, 1);
    t.mock.timers.tick(12_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(test.calls.length, 2);
    t.mock.timers.tick(12_000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(test.calls.length, 3);
    t.mock.timers.tick(6_000);
    await pending;
    assert.equal(Date.now(), 31_000);
    assert.ok(test.calls.every(call => call.options.signal.aborted));
    assert.equal(test.name, "修复数据库连接");
    assert.equal(test.markers[0].source, "fallback");
  });

  it("cancels the runtime request on shutdown and rejects its late result", async t => {
    let resolve: any;
    const test = await setup(t, { complete: () => new Promise(done => { resolve = done; }) });
    const pending = test.manual();
    assert.equal(test.calls.length, 1);
    await test.shutdown();
    assert.equal(test.calls[0].options.signal.aborted, true);
    resolve({ content: [{ type: "text", text: "过期模型标题" }] });
    await pending;
    assert.equal(test.name, undefined);
    assert.deepEqual(test.markers, []);
  });
});
