import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ConnectionStatus } from "../shared/contracts.js";

export interface ConnectionDependencies {
  homeDirectory: string;
  workingDirectory: string;
  environment: NodeJS.ProcessEnv;
}

/** Daemon-only request context. Never return this value from an RPC or persist it. */
export interface AuthenticatedConnection {
  apiUrl: string;
  token: string;
  connectionKey: string;
  userId: string;
}

const cliConfig = z.object({ server_url: z.string().nullish(), app_url: z.string().nullish(), token: z.string().nullish() });
const remoteUser = z.object({ id: z.string().min(1), name: z.string().nullish(), email: z.string().nullish() });

/** Every resolution reads the effective CLI file anew; credentials never enter an RPC result. */
export function createConnectionResolver(dependencies: ConnectionDependencies) {
  return async (profile: string, authenticated?: (connection: AuthenticatedConnection) => void): Promise<ConnectionStatus> => {
    const env = dependencies.environment;
    const base: ConnectionStatus = {
      status: "not_logged_in", profile,
      source: { api: "none", credentials: "none", app: "none" },
      message: "当前 CLI 上下文未登录，请在 daemon 主机运行 CLI 登录。",
      loginCommand: profile ? `multica --profile '${profile.replaceAll("'", "'\\''")}' login` : "multica login",
    };
    const fail = (status: ConnectionStatus["status"], message: string): ConnectionStatus => ({ ...base, status, message });
    const taskContext = !!(env.MULTICA_AGENT_ID || env.MULTICA_TASK_ID || env.MULTICA_DAEMON_PORT)
      || await hasTaskMarker(dependencies.workingDirectory);
    const taskRoot = env.MULTICA_TASK_CONFIG_ROOT?.trim();
    if (taskContext && !taskRoot) return fail("isolated_context", "任务上下文缺少 MULTICA_TASK_CONFIG_ROOT，不能读取拥有者登录。");
    if (taskRoot && !isAbsolute(taskRoot)) return fail("isolated_context", "MULTICA_TASK_CONFIG_ROOT 必须是绝对路径。");
    base.configPath = join(taskRoot || join(dependencies.homeDirectory, ".multica"), ...(profile ? ["profiles", profile] : []), "config.json");

    let config: z.output<typeof cliConfig> = {};
    let configError: "missing_config" | "unreadable_config" | "invalid_config" | undefined;
    try {
      const text = await readFile(base.configPath, "utf8");
      try { config = cliConfig.parse(JSON.parse(text)); } catch { configError = "invalid_config"; }
    } catch (error) {
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
    if (!token) return base;
    try {
      const response = await fetch(`${base.apiUrl}/api/me`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return fail("authentication_failed", "CLI 凭据已失效或无权访问，请在 daemon 主机重新运行 CLI 登录。");
      }
      if (!response.ok) {
        await response.body?.cancel();
        return fail("offline", `Multica 身份验证暂不可用（HTTP ${response.status}）。`);
      }
      const user = remoteUser.parse(await response.json());
      const connectionKey = createHash("sha256").update(JSON.stringify([base.apiUrl, user.id])).digest("hex");
      authenticated?.({ apiUrl: base.apiUrl!, token, connectionKey, userId: user.id });
      return { ...base, status: "ready", user: { id: user.id, name: user.name ?? "", email: user.email ?? "" },
        connectionKey,
        message: "已验证 CLI 连接。" };
    } catch { return fail("offline", "无法验证 Multica 身份，请检查服务连接后重试。"); }
  };
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
