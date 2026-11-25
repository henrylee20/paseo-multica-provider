import { RunSummary } from "./client/run-summary.js";
import { runSummarySchema } from "./shared/runs.js";
import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConnectionScreen } from "./client/connection-screen.js";
import { syncBootstrap } from "./shared/contracts.js";
import { TaskDescription } from "./client/task-description.js";
import { taskDescriptionKind, taskDescriptionSchema, taskDescriptionVersion } from "./shared/description.js";
import { CommentEvent, ThreadSummary } from "./client/thread-events.js";
import { commentEventSchema, threadSummarySchema } from "./shared/threads.js";
import { DeliveryStatus } from "./client/delivery-status.js";
import { deliverySummary } from "./shared/delivery.js";

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
  const openManagement = () => client.openScreen({ screenId: "management" });
  // Settings configures the connection and rules; the sidebar screen also holds records that need handling.
  const removeSettings = client.addSettingsScreen({ id: "multica", title: "Multica", icon: "MessagesSquare",
    Component: props => <ConnectionScreen {...props} scope="settings" openManagement={openManagement} /> });
  const removeScreen = client.addScreen({ id: "management", title: "Multica", Component: props => <ConnectionScreen {...props} scope="management" /> });
  const removeItem = client.addSidebarHeaderItem({ id: "multica", title: "Multica", Component: MulticaItem });
  const removeDescription = client.addTimelineRenderer({ kind: taskDescriptionKind, version: taskDescriptionVersion,
    schema: taskDescriptionSchema, Component: TaskDescription });
  const removeThread = client.addTimelineRenderer({ kind: "thread", version: 1, schema: threadSummarySchema, Component: ThreadSummary });
  const removeRun = client.addTimelineRenderer({ kind: "run-summary", version: 1, schema: runSummarySchema, Component: RunSummary });
  const removeEvent = client.addTimelineRenderer({ kind: "comment-event", version: 1, schema: commentEventSchema, Component: CommentEvent });
  const removeDelivery = client.addTimelineRenderer({ kind: "comment-delivery", version: 1, schema: deliverySummary, Component: props => <DeliveryStatus {...props} openManagement={openManagement} /> });
  return () => { disposed = true; clearInterval(timer); removeDelivery(); removeRun(); removeEvent(); removeThread(); removeDescription(); removeItem(); removeScreen(); removeSettings(); };
}
