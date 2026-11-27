const runStatuses: Record<string, string> = {
  queued: "排队中", dispatched: "已派发", running: "运行中", waiting_local_directory: "等待本地目录",
  deferred: "已推迟", completed: "已完成", failed: "失败", cancelled: "已取消",
};
/** Readable Run status; unknown source values are shown as received. */
export const runStatusLabel = (status: string | undefined) => status ? runStatuses[status] ?? status : "未知";

/** Local "YYYY-MM-DD HH:mm" for display. Unparseable values are shown as received. */
export function formatTime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A calendar date is kept as received, without a UTC-to-local date shift. */
export function formatDate(value: string): string {
  return value.startsWith(`${new Date().getFullYear()}-`) ? value.slice(5) : value;
}

/** Compact local event time; invalid source timestamps have no display value. */
export function formatEventTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const formatted = formatTime(value)!;
  return formatDate(formatted.slice(0, 10)) + formatted.slice(10);
}

export function formatSize(size?: number) {
  return size === undefined ? "大小未知" : size < 1024 ? `${size} B`
    : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
