import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createServerContribution } from "./server/contribute.js";

// Paseo 0.15 eagerly captures bundled exports, so keep the entry declaration hoisted.
export default function contribute(server: PluginServerContext) {
  return createServerContribution()(server);
}
