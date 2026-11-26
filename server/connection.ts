import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { multicaSettings, type ConnectionStatus, type ProfileList } from "../shared/contracts.js";

export interface ConnectionDependencies {
  homeDirectory: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
  currentProfile?: () => Promise<string | undefined>;
}

/** Daemon-only request context. Never return this value from an RPC or persist it. */
export interface AuthenticatedConnection {
  apiUrl: string;
  token: string;
  connectionKey: string;
  userId: string;
  /** Recheck the effective CLI pair before using this resolved context. */
  assertCurrent?: () => Promise<void>;
  signal?: AbortSignal;
  identity?: { user: z.infer<typeof remoteUser>; expiresAt: number };
}

const cliConfig = z.object({ server_url: z.string().nullish(), app_url: z.string().nullish(), token: z.string().nullish() });
const remoteUser = z.object({ id: z.string().min(1), name: z.string().nullish(), email: z.string().nullish() });
const identityTtlMs = 60_000;

/** Only public labels and file metadata are retained, never profile credentials. */
export type ProfileListCache = Map<string, { mtime: number; size: number; expiresAt: number; profile: ProfileList["profiles"][number] }>;

/** Read CLI profiles without touching the active connection's config or identity cache. */
export async function listProfiles(dependencies: ConnectionDependencies, cache: ProfileListCache = new Map()): Promise<ProfileList> {
  const env = dependencies.environment;
  const overridden = !!(env.MULTICA_TOKEN?.trim() || env.MULTICA_SERVER_URL?.trim());
  const isolated = await isTaskContext(env, () => hasTaskMarker(dependencies.workingDirectory));
  if (isolated) return { profiles: [], overridden, isolated };
  const taskRoot = env.MULTICA_TASK_CONFIG_ROOT?.trim();
  if (taskRoot && !isAbsolute(taskRoot)) throw new Error("MULTICA_TASK_CONFIG_ROOT 必须是绝对路径。");
  const root = taskRoot || join(dependencies.homeDirectory, ".multica");
  const names = [""];
  try {
    const entries = await readdir(join(root, "profiles"), { withFileTypes: true });
    names.push(...entries.filter(entry => {
      const parsed = multicaSettings.schema.shape.profile.safeParse(entry.name);
      return entry.isDirectory() && parsed.success && parsed.data === entry.name;
    }).map(entry => entry.name).sort());
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const profiles = (await Promise.all(names.map(async name => {
    const profile: ProfileList["profiles"][number] = { name, loggedIn: false };
    const path = join(root, ...(name ? ["profiles", name] : []), "config.json");
    try {
      const file = await stat(path);
      const cached = cache.get(path);
      if (cached?.mtime === file.mtimeMs && cached.size === file.size && cached.expiresAt > Date.now()) return [cached.profile];
      cache.delete(path);
      const config = cliConfig.parse(JSON.parse(await readFile(path, "utf8")));
      let apiUrl: string | undefined;
      if (config.server_url) {
        try { apiUrl = normalizeApiUrl(config.server_url); profile.apiHost = new URL(apiUrl).host; } catch { /* Invalid URLs have no host label. */ }
      }
      const token = config.token?.trim();
      profile.loggedIn = !!(token && apiUrl);
      let cacheable = false;
      if (profile.loggedIn) {
        try {
          const response = await fetch(`${apiUrl}/api/me`, {
            headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
          });
          if (response.status === 401 || response.status === 403) { profile.loggedIn = false; cacheable = true; }
          if (response.status === 200) {
            const user = remoteUser.parse(await response.json());
            profile.user = user.name?.trim() || user.email?.trim() || undefined;
            cacheable = true;
          } else await response.body?.cancel();
        } catch { /* Unavailable verification keeps a configured login selectable. */ }
      }
      if (cacheable) cache.set(path, { mtime: file.mtimeMs, size: file.size, expiresAt: Date.now() + identityTtlMs, profile });
    } catch (error) {
      cache.delete(path);
      if (name && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    }
    return [profile];
  }))).flat();
  return { profiles, overridden, isolated };
}

/** File metadata is checked on every use; parsed credentials stay in daemon memory. */
export function createConnectionResolver(dependencies: ConnectionDependencies) {
  let active: { fingerprint: string; controller: AbortController; identity?: AuthenticatedConnection["identity"] } | undefined;
  let cachedConfig: { path: string; mtime: number; size: number; value: z.infer<typeof cliConfig> } | undefined;
  let taskMarker: Promise<boolean> | undefined;
  const invalidate = () => { active?.controller.abort(); active = undefined; };
  async function effective(profile: string): Promise<{ status: ConnectionStatus; token?: string }> {
    const env = dependencies.environment;
    const base: ConnectionStatus = {
      status: "not_logged_in", profile,
      source: { api: "none", credentials: "none", app: "none" },
      message: "当前 CLI 上下文未登录，请在 daemon 主机运行 CLI 登录。",
      loginCommand: profile ? `multica --profile '${profile.replaceAll("'", "'\\''")}' login` : "multica login",
    };
    const fail = (status: ConnectionStatus["status"], message: string) => ({ status: { ...base, status, message } });
    const taskContext = await isTaskContext(env, () => taskMarker ??= hasTaskMarker(dependencies.workingDirectory));
    const taskRoot = env.MULTICA_TASK_CONFIG_ROOT?.trim();
    if (taskContext && !taskRoot) return fail("isolated_context", "任务上下文缺少 MULTICA_TASK_CONFIG_ROOT，不能读取拥有者登录。");
    if (taskRoot && !isAbsolute(taskRoot)) return fail("isolated_context", "MULTICA_TASK_CONFIG_ROOT 必须是绝对路径。");
    base.configPath = join(taskRoot || join(dependencies.homeDirectory, ".multica"), ...(profile ? ["profiles", profile] : []), "config.json");

    let config: z.output<typeof cliConfig> = {};
    let configError: "missing_config" | "unreadable_config" | "invalid_config" | undefined;
    try {
      const file = await stat(base.configPath);
      if (cachedConfig?.path === base.configPath && cachedConfig.mtime === file.mtimeMs && cachedConfig.size === file.size) config = cachedConfig.value;
      else {
        if (active) active.identity = undefined;
        const text = await readFile(base.configPath, "utf8");
        try {
          config = cliConfig.parse(JSON.parse(text));
          cachedConfig = { path: base.configPath, mtime: file.mtimeMs, size: file.size, value: config };
        } catch { configError = "invalid_config"; }
      }
    } catch (error) {
      if (cachedConfig) { cachedConfig = undefined; if (active) active.identity = undefined; }
      configError = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing_config" : "unreadable_config";
    }
    const apiOverride = env.MULTICA_SERVER_URL?.trim();
    const tokenOverride = env.MULTICA_TOKEN?.trim();
    const appOverride = env.MULTICA_APP_URL?.trim() || env.FRONTEND_ORIGIN?.trim();
    const rawApi = apiOverride || config.server_url;
    const token = tokenOverride || (taskContext ? "" : config.token);
    const rawApp = appOverride || config.app_url;
    base.source = {
      api: apiOverride ? "environment" : rawApi ? "config" : "none",
      credentials: tokenOverride ? "environment" : token ? "config" : "none",
      app: appOverride ? "environment" : rawApp ? "config" : "none",
    };
    if (configError && (!rawApi || !token)) {
      const messages = { missing_config: "未找到 CLI 配置，请在 daemon 主机运行 multica setup 和 CLI 登录。",
        unreadable_config: "daemon 运行用户无法读取 CLI 配置。", invalid_config: "CLI 配置损坏或字段类型无效，请通过 CLI 修复。" };
      return fail(configError, messages[configError]);
    }
    if (!rawApi) return fail("invalid_config", "CLI 未配置服务地址，请运行 multica setup。");
    try {
      base.apiUrl = normalizeApiUrl(rawApi);
      if (rawApp) base.appUrl = normalizeAppUrl(rawApp);
    } catch { return fail("invalid_config", "CLI 服务或前端地址无效，请通过 CLI 修复。"); }
    if (!token) return { status: base };
    return { status: base, token };
  }
  const resolve = async (profile: string, authenticated?: (connection: AuthenticatedConnection) => void): Promise<ConnectionStatus> => {
    const context = await effective(profile);
    const base = context.status;
    const token = context.token;
    if (dependencies.currentProfile && await dependencies.currentProfile() !== profile) {
      return { ...base, status: "offline", message: "CLI profile 已变化，请重新读取当前连接。" };
    }
    if (!token) { invalidate(); return base; }
    // Only daemon memory contains the opaque credential or this fingerprint.
    const fingerprint = JSON.stringify([profile, base.apiUrl, token]);
    if (active?.fingerprint !== fingerprint) { invalidate(); active = { fingerprint, controller: new AbortController() }; }
    const current = active;
    const controller = current.controller;
    const assertCurrent = async () => {
      const selected = dependencies.currentProfile ? await dependencies.currentProfile() : profile;
      const latest = selected === profile ? await effective(profile) : undefined;
      if (controller.signal.aborted || !latest?.token || latest.status.apiUrl !== base.apiUrl || latest.token !== token) {
        if (active?.controller === controller) invalidate(); else controller.abort();
        throw new Error("CLI 登录上下文已变化；请重新核对此输入所属的连接。");
      }
    };
    const fail = (status: ConnectionStatus["status"], message: string): ConnectionStatus => ({ ...base, status, message });
    try {
      let identity = current.identity;
      if (!identity || identity.expiresAt <= Date.now()) {
        const response = await fetch(`${base.apiUrl}/api/me`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10_000), controller.signal]),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          if (active?.controller === controller) invalidate();
          return fail("authentication_failed", "CLI 凭据已失效或无权访问，请在 daemon 主机重新运行 CLI 登录。");
        }
        if (!response.ok) {
          await response.body?.cancel();
          return fail("offline", `Multica 身份验证暂不可用（HTTP ${response.status}）。`);
        }
        const user = remoteUser.parse(await response.json());
        await assertCurrent();
        current.identity = identity = { user, expiresAt: Date.now() + identityTtlMs };
      }
      const { user } = identity;
      const connectionKey = createHash("sha256").update(JSON.stringify([base.apiUrl, user.id])).digest("hex");
      authenticated?.({ apiUrl: base.apiUrl!, token, connectionKey, userId: user.id, assertCurrent, signal: controller.signal, identity });
      return { ...base, status: "ready", user: { id: user.id, name: user.name ?? "", email: user.email ?? "" },
        connectionKey,
        message: "已验证 CLI 连接。" };
    } catch { if (active?.controller === controller) invalidate(); return fail("offline", "无法验证 Multica 身份，请检查服务连接后重试。"); }
  };
  return Object.assign(resolve, { invalidate });
}

/** All remote reads share the same last-use CLI check; no cached token fallback. */
export async function remoteFetch(connection: AuthenticatedConnection, path: string, init: RequestInit = {}) {
  await connection.assertCurrent?.();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  const signals = [AbortSignal.timeout(10_000), ...(connection.signal ? [connection.signal] : []), ...(init.signal ? [init.signal] : [])];
  const response = await fetch(`${connection.apiUrl}${path}`, { ...init, headers, redirect: "error", signal: AbortSignal.any(signals) });
  if ((response.status === 401 || response.status === 403) && connection.identity) connection.identity.expiresAt = 0;
  return response;
}

function normalizeApiUrl(raw: string) {
  const url = new URL(raw.trim());
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid API URL");
  if (url.pathname === "/ws") url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeAppUrl(raw: string) {
  const url = new URL(raw.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid app URL");
  return raw.trim().replace(/\/+$/, "");
}

async function isTaskContext(env: NodeJS.ProcessEnv, marker: () => Promise<boolean>) {
  return !!(env.MULTICA_AGENT_ID || env.MULTICA_TASK_ID || env.MULTICA_DAEMON_PORT) || await marker();
}

async function hasTaskMarker(cwd: string) {
  let directory = resolve(cwd);
  for (;;) {
    try {
      const marker = JSON.parse(await readFile(join(directory, ".multica", "daemon_task_context.json"), "utf8"));
      if (marker?.managed_by === "multica-daemon-task") return true;
    } catch { /* The CLI ignores absent, unreadable, corrupt and foreign markers. */ }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}
