/** 将运行秒数格式化为中文可读时长（秒 / 分钟 / 小时 分 / 天 小时） */
export function formatUptime(seconds?: number): string {
  if (!seconds || seconds < 60) return `${seconds || 1} 秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours} 小时 ${remMins} 分`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}
