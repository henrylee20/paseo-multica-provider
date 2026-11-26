import { AskuserCard } from "./client/askuser-card.js";
import { askuserCardSchema } from "./shared/askuser.js";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ConnectionScreen } from "./client/connection-screen.js";
import { syncBootstrap } from "./shared/contracts.js";
import { TaskDescription } from "./client/task-description.js";
import { taskDescriptionKind, taskDescriptionSchema, taskDescriptionVersion } from "./shared/description.js";
import { CommentDivider, CommentEvent, ThreadSummary } from "./client/thread-events.js";
import { commentDividerSchema, commentEventSchema, threadSummarySchema } from "./shared/threads.js";
import { DeliveryStatus } from "./client/delivery-status.js";
import { deliverySummary } from "./shared/delivery.js";
import { MentionPicker, composerItemRegistrar } from "./client/mention-picker.js";

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
  // The contribution survives reconnects; a restarted daemon needs bootstrap again.
  const timer = setInterval(() => { void bootstrap(); }, 10_000);
  // The composer's agent picker needs Paseo 0.16.
  const composerItem = composerItemRegistrar(client);
  const removeMention = composerItem ? composerItem({ id: "multica-mention", Component: MentionPicker }) : () => {};
  const removeSettings = client.addSettingsScreen({ id: "multica", title: "Multica", icon: "MessagesSquare", Component: ConnectionScreen });
  const removeSidebar = client.addSidebarHeaderItem({ id: "multica", title: "Multica",
    Component: () => <SidebarRow icon="SlidersHorizontal" onPress={() => client.openSettings("multica")} /> });
  const removeDescription = client.addTimelineRenderer({ kind: taskDescriptionKind, version: taskDescriptionVersion,
    schema: taskDescriptionSchema, Component: TaskDescription });
  const removeThread = client.addTimelineRenderer({ kind: "thread", version: 1, schema: threadSummarySchema, Component: ThreadSummary });
  const removeDivider = client.addTimelineRenderer({ kind: "comment-divider", version: 1, schema: commentDividerSchema, Component: CommentDivider });
  const removeEvent = client.addTimelineRenderer({ kind: "comment-event", version: 1, schema: commentEventSchema, Component: CommentEvent });
  const removeAskuser = client.addTimelineRenderer({ kind: "askuser", version: 1, schema: askuserCardSchema, Component: AskuserCard });
  const removeDelivery = client.addTimelineRenderer({ kind: "comment-delivery", version: 1, schema: deliverySummary, Component: DeliveryStatus });
  return () => {
    disposed = true;
    clearInterval(timer);
    removeAskuser();
    removeDelivery();
    removeEvent();
    removeDivider();
    removeThread();
    removeDescription();
    removeMention();
    removeSidebar();
    removeSettings();
  };
}
