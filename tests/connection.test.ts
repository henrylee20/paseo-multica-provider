import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { createServerContribution } from "../server/contribute.js";
import { connectionStatus, multicaSettings } from "../shared/contracts.js";
import { FakeServer } from "./support/fake-server.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

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
  return { home, requests, remote, apiUrl, path, server, read: () => server.rpc(connectionStatus, {}, {} as PaseoApi) };
}

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
