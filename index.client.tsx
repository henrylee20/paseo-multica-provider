import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConnectionScreen } from "./client/connection-screen.js";

function MulticaItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="MessagesSquare" active={currentScreen?.screenId === "management"}
    onPress={() => openScreen({ screenId: "management" })} />;
}

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({ id: "multica", title: "Multica", icon: "MessagesSquare", Component: ConnectionScreen });
  const removeScreen = client.addScreen({ id: "management", title: "Multica", Component: ConnectionScreen });
  const removeItem = client.addSidebarHeaderItem({ id: "multica", title: "Multica", Component: MulticaItem });
  return () => { removeItem(); removeScreen(); removeSettings(); };
}
