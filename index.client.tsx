import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConnectionScreen } from "./client/connection-screen.js";
import { syncBootstrap } from "./shared/contracts.js";

function MulticaItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="MessagesSquare" active={currentScreen?.screenId === "management"}
    onPress={() => openScreen({ screenId: "management" })} />;
}

export default function contribute(client: PluginClientContext) {
  let disposed = false;
  let inFlight = false;
  async function bootstrap() {
    if (disposed || inFlight) return;
    inFlight = true;
    try { await client.rpc(syncBootstrap, {}); } catch { /* Retry on the next connection opportunity. */ }
    finally { inFlight = false; }
  }
  void bootstrap();
  // Client setup survives reconnects. Keep retrying even when management was never opened.
  const timer = setInterval(() => { void bootstrap(); }, 10_000);
  const removeSettings = client.addSettingsScreen({ id: "multica", title: "Multica", icon: "MessagesSquare", Component: ConnectionScreen });
  const removeScreen = client.addScreen({ id: "management", title: "Multica", Component: ConnectionScreen });
  const removeItem = client.addSidebarHeaderItem({ id: "multica", title: "Multica", Component: MulticaItem });
  return () => { disposed = true; clearInterval(timer); removeItem(); removeScreen(); removeSettings(); };
}
