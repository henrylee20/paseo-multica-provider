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
