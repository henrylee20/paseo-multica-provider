import { useRef, type ComponentType } from "react";
import * as PluginClient from "@getpaseo/plugin/client";
import * as PluginUi from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginClientContext, type PluginHostProps } from "@getpaseo/plugin/client";
import { deliveryMentions } from "../shared/delivery.js";
import { discussionKeys } from "../shared/discussion.js";

type MentionAgent = { id: string; name: string; reference: string };
type Choice = MentionAgent & { label: string; description: string };

/**
 * The composer surface Paseo 0.16 added. Development stays on SDK 0.15.4, whose types stop before
 * it; a host of that version leaves every member undefined and never mounts the picker.
 */
interface PickerComposer {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly prompt: string;
  readonly agent: { readonly metadata: Readonly<Record<string, unknown>> };
  insertText(text: string): void;
  focus(): Promise<void>;
}
interface PickerItemContribution {
  id: string;
  Component: ComponentType<PluginHostProps>;
}
interface PickerComboboxProps {
  title: string;
  icon: string;
  value: null;
  search(event: { query: string }): Promise<readonly Choice[]>;
  onSelect(event: { item: Choice }): void | Promise<void>;
}
const composerSurface = PluginClient as unknown as { useComposer(): PickerComposer };
const Combobox = (PluginUi as unknown as { Combobox: ComponentType<PickerComboboxProps> }).Combobox;

/** The composer-item registration Paseo 0.16 added, or null on an older host, which never draws the picker. */
export function composerItemRegistrar(client: PluginClientContext): ((contribution: PickerItemContribution) => () => void) | null {
  const add = (client as unknown as { addComposerItem?(contribution: PickerItemContribution): () => void }).addComposerItem;
  return typeof add === "function" ? add.bind(client) : null;
}

/** Only a running Multica discussion names a task: the daemon copies it into metadata from the agent's labels. */
function taskOf(composer: PickerComposer) {
  const connectionKey = composer.agent.metadata[discussionKeys.connection];
  const issueId = composer.agent.metadata[discussionKeys.issue];
  return composer.context === "agent" && typeof connectionKey === "string" && typeof issueId === "string" ? { connectionKey, issueId } : null;
}

/** Inserts a Multica agent's canonical reference at the cursor; sending the message stays the user's step. */
export function MentionPicker() {
  const composer = composerSurface.useComposer();
  const mentions = useRpc(deliveryMentions);
  const reading = useRef<{ address: string; agents: Promise<readonly MentionAgent[]> } | null>(null);
  const task = taskOf(composer);
  if (!task) return null;
  const address = JSON.stringify(task);
  const read = () => {
    const agents = mentions(task).then(result => result.agents);
    reading.current = { address, agents };
    // A failed reading is dropped, so the next query reads again instead of repeating it.
    void agents.catch(() => { if (reading.current?.agents === agents) reading.current = null; });
    return agents;
  };
  const search = async ({ query }: { query: string }): Promise<readonly Choice[]> => {
    // The list opens with an empty query: read the task's agents then, and filter that reading as the user types.
    const agents = await (query && reading.current?.address === address ? reading.current.agents : read());
    // Same-name agents stay apart by ID, which the list shows and the search also matches.
    const needle = query.trim().toLowerCase();
    return agents.filter(agent => agent.name.toLowerCase().includes(needle) || agent.id.toLowerCase().includes(needle))
      .map(agent => ({ ...agent, label: agent.name, description: `ID ${agent.id}` }));
  };
  const select = async ({ item }: { item: Choice }) => {
    // Directly after "!" or "\" the reference would not be a link in Markdown, so a non-empty prompt keeps a gap before it.
    composer.insertText(`${composer.prompt ? " " : ""}${item.reference} `);
    await composer.focus();
  };
  return <Combobox title="提及 Agent" icon="AtSign" value={null} search={search} onSelect={select} />;
}
