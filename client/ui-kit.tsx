import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Free content inside a SettingsCard. The card adds no padding of its own (only rows do),
 * so bare Text children would touch the card edge.
 */
export function CardBody({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  return <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap }}>{children}</View>;
}

/** A section header's trailing action, as Paseo places Refresh or Add. */
export function HeaderAction({ theme, label, icon = "RefreshCw", onPress, disabled }: {
  theme: Theme; label: string; icon?: string; onPress(): void; disabled?: boolean
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} disabled={disabled} onPress={onPress}
    // The 4px right margin mirrors the section header's own left inset, so the label ends on the card's rail.
    style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4, opacity: disabled ? 0.5 : 1 }}>
    <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{label}</Text>
  </Pressable>;
}

/** A failure that belongs to a whole section rather than one row. */
export function Notice({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, marginHorizontal: 4 }}>{children}</Text>;
}

/** A label above a card inside a section, matching the host's muted section titles. */
export function SubHeading({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginHorizontal: 4 }}>{children}</Text>;
}
