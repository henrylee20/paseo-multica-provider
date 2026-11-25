import type { AuthenticatedConnection } from "./connection.js";
import type { RemoteWorkspace } from "./sync.js";

export type WorkspaceEvent = { connectionKey: string; workspaceId: string; type: string; payload?: unknown };
type Subscription = { fingerprint: string; signal?: AbortSignal; close(): void };

/** Workspace-wide invalidations include issues that have never been imported. */
export class WorkspaceEvents {
  private closed = false;
  private subscriptions = new Map<string, Subscription>();
  constructor(private readonly onInvalidate: (event: WorkspaceEvent) => void) {}

  reconcile(connection: AuthenticatedConnection, workspaces: RemoteWorkspace[]) {
    if (this.closed) return;
    const keys = new Set(workspaces.map(workspace => `${connection.connectionKey}:${workspace.id}`));
    for (const [key, subscription] of this.subscriptions) {
      if (!keys.has(key)) { subscription.close(); this.subscriptions.delete(key); }
    }
    for (const workspace of workspaces) {
      const key = `${connection.connectionKey}:${workspace.id}`;
      // Token is held only in this daemon memory, never in URLs, state, RPC or logs.
      const fingerprint = JSON.stringify([connection.apiUrl, connection.token, workspace.slug]);
      if (this.subscriptions.get(key)?.fingerprint === fingerprint && this.subscriptions.get(key)?.signal === connection.signal) continue;
      this.subscriptions.get(key)?.close();
      let closed = false;
      let socket: WebSocket | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let authenticated = false;
      const notify = (type: string, payload?: unknown) => this.onInvalidate({ connectionKey: connection.connectionKey, workspaceId: workspace.id, type, payload });
      const retire = () => { closed = true; if (retry) clearTimeout(retry); try { socket?.close(); } catch {} };
      const connect = async () => {
        if (closed || connection.signal?.aborted) return;
        try { await connection.assertCurrent?.(); } catch { retire(); return; }
        if (closed || connection.signal?.aborted) return;
        authenticated = false;
        const url = new URL(`${connection.apiUrl}/ws`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("workspace_slug", workspace.slug);
        socket = new WebSocket(url);
        socket.addEventListener("open", () => {
          void (async () => {
            try { await connection.assertCurrent?.(); if (!closed) socket!.send(JSON.stringify({ type: "auth", payload: { token: connection.token } })); }
            catch { retire(); }
          })();
        });
        socket.addEventListener("message", message => {
          if (closed || typeof message.data !== "string") return;
          let event: { type?: unknown; payload?: unknown };
          try { event = JSON.parse(message.data); } catch { return; }
          if (event.type === "auth_ack") {
            authenticated = true;
            // There is no replay cursor: every authenticated connection requires a snapshot.
            notify("auth_ack");
          } else if (authenticated && typeof event.type === "string" &&
            /^(issue:|issue_[a-z_]+:|comment:|member:|agent:|squad:|project:|label:|workspace:|task:)/.test(event.type)) {
            notify(event.type, event.payload);
          }
        });
        socket.addEventListener("error", () => { try { socket?.close(); } catch {} });
        socket.addEventListener("close", () => {
          if (!closed && !connection.signal?.aborted) { retry = setTimeout(() => { void connect(); }, 1_000); retry.unref?.(); }
        });
      };
      connection.signal?.addEventListener("abort", retire, { once: true });
      this.subscriptions.set(key, { fingerprint, signal: connection.signal, close: () => {
        connection.signal?.removeEventListener("abort", retire);
        retire();
      } });
      void connect();
    }
  }
  disconnect() { for (const subscription of this.subscriptions.values()) subscription.close(); this.subscriptions.clear(); }
  close() { this.closed = true; this.disconnect(); }
}
