import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, rename, readFile, symlink, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { createServerContribution } from "../server/contribute.js";
import { connectionStatus, multicaSettings, profileList, workspaceList } from "../shared/contracts.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
it("settings keep version 1, default legacy documents to 15 seconds and reject unsupported polling intervals", () => {
  expect(multicaSettings.version).toBe(1);
  expect(multicaSettings.schema.parse({})).toEqual({ profile: "", syncIntervalSeconds: 15 });
  expect(multicaSettings.schema.parse({ profile: "office" })).toEqual({ profile: "office", syncIntervalSeconds: 15 });
  for (const value of [10, 15, 30, 60, 120, 300, 600]) expect(multicaSettings.schema.parse({ syncIntervalSeconds: value }).syncIntervalSeconds).toBe(value);
  for (const value of [0, 9, 11, 16, 30.5, 601, "15", null]) expect(multicaSettings.schema.safeParse({ syncIntervalSeconds: value }).success).toBe(false);
});
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });

async function fixture(profile = "", environment: NodeJS.ProcessEnv = {}) {
  const home = await mkdtemp(join(tmpdir(), "paseo-multica-cli-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const requests: Array<{ path: string; authorization?: string }> = [];
  const remote = { status: 200, body: { id: "user-42", name: "Lin", email: "lin@example.test" } as unknown };
  const http = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    response.statusCode = remote.status;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(remote.body));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); }));
  const address = http.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing HTTP address");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const path = join(home, ".multica", ...(profile ? ["profiles", profile] : []), "config.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ server_url: `${apiUrl}/`, app_url: "https://tasks.example.test:8443/", token: "opaque-existing-credential" }));
  const server = new FakeServer();
  const dispose = createServerContribution({ homeDirectory: home, environment, workingDirectory: home })(server.context);
  cleanup.push(dispose);
  return { home, requests, remote, apiUrl, path, server, read: () => server.rpc(connectionStatus, {}, {} as PaseoApi),
    list: () => server.rpc(profileList, {}, {} as PaseoApi) };
}

it("lists CLI files safely and verifies each configured login using only its own credentials and service", async () => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ id: "user", name: "Lin" })));
  const root = join(f.home, ".multica", "profiles");
  const configs = {
    office: JSON.stringify({ server_url: " wss://office.example.test:8443/ws?secret=url-secret#fragment ", token: " office-secret " }),
    logout: JSON.stringify({ server_url: "https://logout.example.test" }),
    blank: JSON.stringify({ server_url: f.apiUrl, token: " \n " }),
    "blank-server": JSON.stringify({ server_url: " \n ", token: "blank-server-secret" }),
    corrupt: "{corrupt-secret",
    invalid: JSON.stringify({ server_url: f.apiUrl, token: 42 }),
    "invalid-url": JSON.stringify({ server_url: "not a URL", token: "invalid-url-secret" }),
    "bad\\name": JSON.stringify({ server_url: f.apiUrl, token: "unsafe-secret" }),
    "bad\u001fname": JSON.stringify({ server_url: f.apiUrl, token: "control-secret" }),
    ["x".repeat(129)]: JSON.stringify({ server_url: f.apiUrl, token: "long-name-secret" }),
    " office ": JSON.stringify({ server_url: f.apiUrl, token: "trimmed-name-secret" }),
  };
  for (const [name, config] of Object.entries(configs)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "config.json"), config);
  }
  await mkdir(join(root, "missing"));
  await mkdir(join(root, "unreadable", "config.json"), { recursive: true });
  await writeFile(join(root, "file-entry"), "not a directory");
  await symlink(join(root, "office"), join(root, "symlink-entry"));
  const result = await f.list();
  expect(result).toEqual({ profiles: [
    { name: "", loggedIn: true, apiHost: new URL(f.apiUrl).host, user: "Lin" },
    { name: "blank", loggedIn: false, apiHost: new URL(f.apiUrl).host },
    { name: "blank-server", loggedIn: false },
    { name: "corrupt", loggedIn: false },
    { name: "invalid", loggedIn: false },
    { name: "invalid-url", loggedIn: false },
    { name: "logout", loggedIn: false, apiHost: "logout.example.test" },
    { name: "office", loggedIn: true, apiHost: "office.example.test:8443", user: "Lin" },
    { name: "unreadable", loggedIn: false },
  ], overridden: false, isolated: false });
  expect(f.requests).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenCalledWith(`${f.apiUrl}/api/me`, expect.objectContaining({ headers: { Authorization: "Bearer opaque-existing-credential" }, redirect: "error" }));
  expect(fetch).toHaveBeenCalledWith("https://office.example.test:8443/api/me", expect.objectContaining({ headers: { Authorization: "Bearer office-secret" }, redirect: "error" }));
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("opaque-existing-credential");
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain('"token"');
});

it("listing other profiles leaves the active connection's identity verification cached", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".multica", "profiles", "other"), { recursive: true });
  await writeFile(join(f.home, ".multica", "profiles", "other", "config.json"), JSON.stringify({ server_url: f.apiUrl, token: "other-secret" }));
  const original = await f.read();
  expect(original.status).toBe("ready");
  expect(f.requests).toHaveLength(1);
  expect((await f.list()).profiles).toHaveLength(2);
  expect(f.requests).toHaveLength(3);
  expect(f.requests.slice(1).map(request => request.authorization).sort()).toEqual(["Bearer opaque-existing-credential", "Bearer other-secret"].sort());
  expect(await f.read()).toEqual(original);
  expect(f.requests).toHaveLength(3);
});

it("profile labels ignore environment overrides and send unselected credentials only to their configured service", async () => {
  const f = await fixture("", { MULTICA_TOKEN: "environment-secret", MULTICA_SERVER_URL: "https://override.example.test" });
  const other = await fixture("office");
  await mkdir(join(f.home, ".multica", "profiles", "office"), { recursive: true });
  await writeFile(join(f.home, ".multica", "profiles", "office", "config.json"), JSON.stringify({ server_url: `${other.apiUrl}/ws`, token: "office-secret" }));
  other.remote.body = { id: "other", name: "Kai" };
  const result = await f.list();
  expect(result).toEqual({ profiles: [
    { name: "", loggedIn: true, apiHost: new URL(f.apiUrl).host, user: "Lin" },
    { name: "office", loggedIn: true, apiHost: new URL(other.apiUrl).host, user: "Kai" },
  ], overridden: true, isolated: false });
  expect(f.requests).toEqual([{ path: "/api/me", authorization: "Bearer opaque-existing-credential" }]);
  expect(other.requests).toEqual([{ path: "/api/me", authorization: "Bearer office-secret" }]);
  for (const secret of ["environment-secret", "office-secret", "opaque-existing-credential", '"token"']) expect(JSON.stringify(result)).not.toContain(secret);
});

it.each(["", null, " \n "])("profile display names fall back to email when name is %j", async name => {
  const f = await fixture();
  f.remote.body = { id: "user", name, email: "lin@example.test" };
  expect((await f.list()).profiles[0]).toMatchObject({ loggedIn: true, user: "lin@example.test" });
});

it.each([401, 403])("HTTP %s marks a profile logged out and caches that decision briefly", async status => {
  const f = await fixture();
  f.remote.status = status;
  expect((await f.list()).profiles[0]).toEqual({ name: "", loggedIn: false, apiHost: new URL(f.apiUrl).host });
  await f.list();
  expect(f.requests).toHaveLength(1);
});

it.each([
  { label: "HTTP 503", status: 503, body: '{"error":"unavailable"}', cacheable: false },
  { label: "an invalid identity", status: 200, body: '{"name":"missing ID"}', cacheable: false },
  { label: "invalid JSON", status: 200, body: "{broken", cacheable: false },
  { label: "empty names and emails", status: 200, body: '{"id":"user","name":"  ","email":""}', cacheable: true },
])("profile verification keeps a configured login without a user on $label", async ({ status, body, cacheable }) => {
  const f = await fixture();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
  expect((await f.list()).profiles[0]).toEqual({ name: "", loggedIn: true, apiHost: new URL(f.apiUrl).host });
  await f.list();
  expect(fetch).toHaveBeenCalledTimes(cacheable ? 1 : 2);
});

it("a profile listing immediately retries after a temporary HTTP failure and returns the recovered user", async () => {
  const f = await fixture();
  f.remote.status = 503;
  expect((await f.list()).profiles[0]).toEqual({ name: "", loggedIn: true, apiHost: new URL(f.apiUrl).host });
  f.remote.status = 200;
  expect((await f.list()).profiles[0]).toMatchObject({ loggedIn: true, user: "Lin" });
  expect(f.requests).toHaveLength(2);
});

it("network failures keep a configured profile selectable without a display name", async () => {
  const f = await fixture();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
  expect((await f.list()).profiles[0]).toEqual({ name: "", loggedIn: true, apiHost: new URL(f.apiUrl).host });
});

it("profile verification uses a five-second timeout and starts profiles in parallel", async () => {
  const f = await fixture();
  await mkdir(join(f.home, ".multica", "profiles", "office"), { recursive: true });
  await writeFile(join(f.home, ".multica", "profiles", "office", "config.json"), JSON.stringify({ server_url: f.apiUrl, token: "office-secret" }));
  const controllers: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const controller = new AbortController(); controllers.push(controller); return controller.signal;
  });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
  }));
  const listing = f.list();
  try {
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(timeout.mock.calls).toEqual([[5_000], [5_000]]);
  } finally { for (const controller of controllers) controller.abort(new DOMException("Timed out", "TimeoutError")); }
  expect((await listing).profiles.map(profile => ({ loggedIn: profile.loggedIn, user: profile.user }))).toEqual([
    { loggedIn: true, user: undefined }, { loggedIn: true, user: undefined },
  ]);
});

it("profile label caches expire at 60 seconds and recheck both file mtime and size", async () => {
  const f = await fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = await f.list();
  f.remote.body = { id: "user", name: "Kai" };
  now += 59_999;
  expect(await f.list()).toEqual(original);
  expect(f.requests).toHaveLength(1);
  now += 1;
  expect((await f.list()).profiles[0].user).toBe("Kai");
  expect(f.requests).toHaveLength(2);

  // A timestamp-only change and a size-only change each invalidate the label.
  const before = await stat(f.path);
  await utimes(f.path, before.atime, new Date(before.mtimeMs + 2_000));
  f.remote.status = 403;
  expect((await f.list()).profiles[0].loggedIn).toBe(false);
  expect(f.requests).toHaveLength(3);
  const changed = await stat(f.path);
  await writeFile(f.path, `${await readFile(f.path, "utf8")}\n`);
  await utimes(f.path, changed.atime, changed.mtime);
  f.remote.status = 200;
  expect((await f.list()).profiles[0]).toMatchObject({ loggedIn: true, user: "Kai" });
  expect(f.requests).toHaveLength(4);

  await writeFile(f.path, JSON.stringify({ server_url: f.apiUrl }));
  expect((await f.list()).profiles[0]).toEqual({ name: "", loggedIn: false, apiHost: new URL(f.apiUrl).host });
  expect(f.requests).toHaveLength(4);
});

it("profile display caches belong to each contribution lifecycle", async () => {
  const f = await fixture();
  await f.list();
  f.remote.body = { id: "user", name: "Kai" };
  const server = new FakeServer();
  cleanup.push(createServerContribution({ homeDirectory: f.home, workingDirectory: f.home, environment: {} })(server.context));
  expect((await server.rpc(profileList, {}, {} as PaseoApi)).profiles[0].user).toBe("Kai");
  expect((await f.list()).profiles[0].user).toBe("Lin");
  expect(f.requests).toHaveLength(2);
});

it("missing default config and profiles directory are ordinary logged-out listings", async () => {
  const f = await fixture();
  await rm(f.path);
  expect(await f.list()).toEqual({ profiles: [{ name: "", loggedIn: false }], overridden: false, isolated: false });
  expect(f.requests).toEqual([]);
});

it("lists only the absolute MULTICA_TASK_CONFIG_ROOT when configured", async () => {
  const environment: NodeJS.ProcessEnv = {};
  const f = await fixture("owner", environment);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ id: "user", name: "Lin" })));
  const root = join(f.home, "task-private");
  environment.MULTICA_TASK_CONFIG_ROOT = ` ${root} `;
  await mkdir(join(root, "profiles", "task"), { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ server_url: "ws://private.example.test:8080/ws", token: "private-root-secret" }));
  await writeFile(join(root, "profiles", "task", "config.json"), JSON.stringify({ server_url: "https://task.example.test", token: "private-task-secret" }));
  expect(await f.list()).toEqual({ profiles: [
    { name: "", loggedIn: true, apiHost: "private.example.test:8080", user: "Lin" }, { name: "task", loggedIn: true, apiHost: "task.example.test", user: "Lin" },
  ], overridden: false, isolated: false });
  expect(fetch).toHaveBeenCalledTimes(2);
  environment.MULTICA_TASK_CONFIG_ROOT = "relative/path";
  await expect(f.list()).rejects.toThrow("MULTICA_TASK_CONFIG_ROOT 必须是绝对路径");
  expect(f.requests).toEqual([]);
});

it.each(["MULTICA_TOKEN", "MULTICA_SERVER_URL"])("reports a nonempty %s override without exposing it", async key => {
  const environment: NodeJS.ProcessEnv = { [key]: " \n " };
  const f = await fixture("", environment);
  expect((await f.list()).overridden).toBe(false);
  environment[key] = " environment-secret ";
  const result = await f.list();
  expect(result.overridden).toBe(true);
  expect(JSON.stringify(result)).not.toContain("environment-secret");
  expect(f.requests).toEqual([{ path: "/api/me", authorization: "Bearer opaque-existing-credential" }]);
});

it.each(["MULTICA_AGENT_ID", "MULTICA_TASK_ID", "MULTICA_DAEMON_PORT"])("isolation from %s hides owner profiles and hosts without authenticating", async key => {
  const environment: NodeJS.ProcessEnv = { [key]: "task" };
  const f = await fixture("owner", environment);
  expect(await f.list()).toEqual({ profiles: [], overridden: false, isolated: true });
  environment.MULTICA_TASK_CONFIG_ROOT = join(f.home, ".multica");
  expect(await f.list()).toEqual({ profiles: [], overridden: false, isolated: true });
  environment.MULTICA_TASK_CONFIG_ROOT = "relative/path";
  environment.MULTICA_TOKEN = "injected-secret";
  expect(await f.list()).toEqual({ profiles: [], overridden: true, isolated: true });
  expect(f.requests).toEqual([]);
});

it("shares task marker detection with connection resolution, including ancestor markers", async () => {
  const f = await fixture("owner");
  await mkdir(join(f.home, "nested", "workspace"), { recursive: true });
  const server = new FakeServer();
  cleanup.push(createServerContribution({ homeDirectory: f.home, workingDirectory: join(f.home, "nested", "workspace"), environment: {} })(server.context));
  const marker = join(f.home, ".multica", "daemon_task_context.json");
  for (const contents of ["{broken", JSON.stringify({ managed_by: "foreign" })]) {
    await writeFile(marker, contents);
    expect((await server.rpc(profileList, {}, {} as PaseoApi)).isolated).toBe(false);
  }
  expect(f.requests).toHaveLength(1);
  await writeFile(marker, JSON.stringify({ managed_by: "multica-daemon-task" }));
  expect(await server.rpc(profileList, {}, {} as PaseoApi)).toEqual({ profiles: [], overridden: false, isolated: true });
  expect(await server.rpc(connectionStatus, {}, {} as PaseoApi)).toMatchObject({ status: "isolated_context" });
  expect(f.requests).toHaveLength(1);
});

it("the public contribution verifies the default CLI connection without exposing its credential", async () => {
  const f = await fixture();
  const status = await f.read();
  expect(status).toMatchObject({ status: "ready", profile: "", apiUrl: f.apiUrl, appUrl: "https://tasks.example.test:8443", user: { id: "user-42", name: "Lin" }, source: { credentials: "config", api: "config" } });
  expect(f.requests).toEqual([{ path: "/api/me", authorization: "Bearer opaque-existing-credential" }]);
  expect(JSON.stringify(status)).not.toContain("opaque-existing-credential");
});

it("explicit named profiles and environment overrides follow the CLI without mixing in default-profile settings", async () => {
  const f = await fixture("office");
  f.server.setSettings(multicaSettings.id, { profile: "office" });
  await writeFile(join(f.home, ".multica", "config.json"), JSON.stringify({ server_url: "http://wrong.invalid", token: "wrong-default" }));
  expect(await f.read()).toMatchObject({ status: "ready", profile: "office", configPath: f.path, apiUrl: f.apiUrl });
  const env: NodeJS.ProcessEnv = {};
  const overridden = await fixture("office", env);
  overridden.server.setSettings(multicaSettings.id, { profile: "office" });
  env.MULTICA_SERVER_URL = `${f.apiUrl}/ws?discard=yes`;
  env.MULTICA_TOKEN = " environment-credential ";
  env.MULTICA_APP_URL = "https://front.example.test:9443/";
  const status = await overridden.read();
  expect(status).toMatchObject({ status: "ready", apiUrl: f.apiUrl, appUrl: "https://front.example.test:9443", source: { api: "environment", credentials: "environment", app: "environment" } });
  expect(f.requests.at(-1)).toEqual({ path: "/api/me", authorization: "Bearer environment-credential" });
  expect(overridden.requests).toEqual([]);
});

it("task contexts never borrow owner-profile credentials, even when task identity environment is lost", async () => {
  const environment: NodeJS.ProcessEnv = { MULTICA_DAEMON_PORT: "4200" };
  const f = await fixture("", environment);
  expect(await f.read()).toMatchObject({ status: "isolated_context" });
  expect(f.requests).toEqual([]);
  const root = join(f.home, "task-private");
  await mkdir(root);
  await writeFile(join(root, "config.json"), JSON.stringify({ server_url: f.apiUrl, token: "task-file-not-owner" }));
  environment.MULTICA_TASK_CONFIG_ROOT = root;
  expect(await f.read()).toMatchObject({ status: "not_logged_in", source: { credentials: "none" } });
  environment.MULTICA_TOKEN = "injected-opaque-token";
  expect(await f.read()).toMatchObject({ status: "ready", configPath: join(root, "config.json"), source: { credentials: "environment" } });
  expect(f.requests).toEqual([{ path: "/api/me", authorization: "Bearer injected-opaque-token" }]);
  delete environment.MULTICA_DAEMON_PORT;
  delete environment.MULTICA_TASK_CONFIG_ROOT;
  delete environment.MULTICA_TOKEN;
  await writeFile(join(f.home, ".multica", "daemon_task_context.json"), JSON.stringify({ managed_by: "multica-daemon-task" }));
  expect(await f.read()).toMatchObject({ status: "isolated_context" });
  expect(f.requests).toHaveLength(1);
});

it("missing, unreadable, malformed, logged-out and rejected CLI credentials remain distinguishable", async () => {
  const f = await fixture();
  await rm(f.path);
  expect(await f.read()).toMatchObject({ status: "missing_config", loginCommand: "multica login" });
  await mkdir(f.path);
  expect(await f.read()).toMatchObject({ status: "unreadable_config" });
  await rm(f.path, { recursive: true });
  await writeFile(f.path, "{broken opaque-existing-credential");
  expect(await f.read()).toMatchObject({ status: "invalid_config" });
  await writeFile(f.path, JSON.stringify({ server_url: f.apiUrl }));
  expect(await f.read()).toMatchObject({ status: "not_logged_in" });
  await writeFile(f.path, JSON.stringify({ server_url: f.apiUrl, token: "expired-credential" }));
  f.remote.status = 401;
  f.remote.body = { error: "expired-credential detail must not be relayed" };
  const status = await f.read();
  expect(status).toMatchObject({ status: "authentication_failed", loginCommand: "multica login" });
  expect(JSON.stringify(status)).not.toContain("expired-credential");
});

it("an invalid profile cannot escape the daemon user's CLI profile directory", async () => {
  const f = await fixture();
  f.server.setSettings(multicaSettings.id, { profile: "../../outside" });
  expect(await f.read()).toMatchObject({ status: "invalid_settings" });
  expect(f.requests).toEqual([]);
});

it("atomic CLI replacement rotates credentials, logout removes access, and service/user identity determines the connection key", async () => {
  const f = await fixture();
  const original = await f.read();
  const rotated = JSON.stringify({ server_url: f.apiUrl, app_url: "https://tasks.example.test", token: "rotated-credential" });
  await writeFile(`${f.path}.next`, rotated);
  await rename(`${f.path}.next`, f.path);
  expect(await f.read()).toMatchObject({ status: "ready", connectionKey: original.connectionKey });
  expect(f.requests.at(-1)?.authorization).toBe("Bearer rotated-credential");
  expect(await readFile(f.path, "utf8")).toBe(rotated);
  f.remote.body = { id: "different-user", name: "Kai", email: "kai@example.test" };
  await writeFile(f.path, JSON.stringify({ server_url: f.apiUrl, token: "other-user-credential" }));
  const switched = await f.read();
  expect(switched.connectionKey).not.toBe(original.connectionKey);
  const otherService = await fixture();
  expect((await otherService.read()).connectionKey).not.toBe(original.connectionKey);
  const callsBeforeLogout = f.requests.length;
  await writeFile(`${f.path}.next`, JSON.stringify({ server_url: f.apiUrl }));
  await rename(`${f.path}.next`, f.path);
  const loggedOut = await f.read();
  expect(loggedOut).toMatchObject({ status: "not_logged_in", source: { credentials: "none" } });
  expect(loggedOut.user).toBeUndefined();
  expect(loggedOut.connectionKey).toBeUndefined();
  expect(f.requests).toHaveLength(callsBeforeLogout);
});

it("complete environment login works without a profile file and is lost when its effective credential is removed", async () => {
  const environment: NodeJS.ProcessEnv = {};
  const f = await fixture("", environment);
  await rm(f.path);
  environment.MULTICA_SERVER_URL = f.apiUrl;
  environment.MULTICA_TOKEN = "environment-only-token";
  environment.FRONTEND_ORIGIN = "https://front.example.test";
  environment.MULTICA_PROFILE = "must-not-be-selected-implicitly";
  expect(await f.read()).toMatchObject({ status: "ready", profile: "", appUrl: "https://front.example.test", source: { credentials: "environment", api: "environment", app: "environment" } });
  delete environment.MULTICA_TOKEN;
  expect(await f.read()).toMatchObject({ status: "missing_config" });
  expect(f.requests).toHaveLength(1);
});

it("server errors and malformed identity responses never become a verified user", async () => {
  const f = await fixture();
  f.remote.status = 503;
  f.remote.body = { error: "opaque-existing-credential" };
  expect(await f.read()).toMatchObject({ status: "offline" });
  f.remote.status = 200;
  f.remote.body = { name: "missing id" };
  expect(await f.read()).toMatchObject({ status: "offline" });
});

it("reuses identity briefly while config edits and TTL expiry force verification", async () => {
  const f = await fixture();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const original = await f.read();
  expect(await f.read()).toEqual(original);
  expect(f.requests).toHaveLength(1);
  now += 60_001;
  expect(await f.read()).toEqual(original);
  expect(f.requests).toHaveLength(2);
  await writeFile(f.path, `${await readFile(f.path, "utf8")}\n`);
  expect(await f.read()).toEqual(original);
  expect(f.requests).toHaveLength(3);
});

it.each([401, 403])("HTTP %s invalidates the cached identity without waiting for its TTL", async status => {
  const f = await fixture();
  expect(await f.read()).toMatchObject({ status: "ready" });
  f.remote.status = status;
  await expect(f.server.rpc(workspaceList, {}, {} as PaseoApi)).rejects.toThrow();
  expect(await f.read()).toMatchObject({ status: "authentication_failed" });
  expect(f.requests.map(request => request.path)).toEqual(["/api/me", "/api/workspaces", "/api/me"]);
});
