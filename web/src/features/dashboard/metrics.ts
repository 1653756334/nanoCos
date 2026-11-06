import type { Bucket, CategoryStat, SystemStats } from '../../lib/api';
import type { VisibilityFilter } from './types';

/** 后端尚无分类统计时的占位分类（全部为 0） */
export const DEFAULT_CATEGORIES: CategoryStat[] = [
  { category: 'image', label: '图片媒体 (Images)', color: '#3b82f6', objectCount: 0, sizeBytes: 0, percent: 0 },
  { category: 'media', label: '音视频流 (Video/Audio)', color: '#8b5cf6', objectCount: 0, sizeBytes: 0, percent: 0 },
  { category: 'doc', label: '文档与代码 (Docs/Code)', color: '#10b981', objectCount: 0, sizeBytes: 0, percent: 0 },
  { category: 'archive', label: '归档与二进制 (Archives/Bin)', color: '#f59e0b', objectCount: 0, sizeBytes: 0, percent: 0 },
];

/** 仪表盘顶部指标卡与图表共用的派生数据 */
export interface DashboardSummary {
  categories: CategoryStat[];
  publicBucketCount: number;
  privateBucketCount: number;
  /** 去重率（保留 1 位小数） */
  dedupPct: number;
  /** 块平均引用比（字符串，保留 2 位小数） */
  avgRef: string;
  /** 物理 / 逻辑落盘比（0~100 整数） */
  physicalRatio: number;
}

export function summarizeDashboard(stats: SystemStats | null, buckets: Bucket[]): DashboardSummary {
  const categories = stats?.categories?.length ? stats.categories : DEFAULT_CATEGORIES;
  const publicBucketCount = buckets.filter((b) => b.visibility === 'public-read').length;
  const privateBucketCount = buckets.length - publicBucketCount;
  const dedupPct = Number((stats?.dedupRatioPercent ?? 0).toFixed(1));
  const avgRef = (stats?.avgRefCount ?? 1.0).toFixed(2);
  const physicalRatio =
    stats && stats.logicalBytes > 0
      ? Math.min(100, Math.round((stats.physicalBytes * 100) / stats.logicalBytes))
      : 100;
  return { categories, publicBucketCount, privateBucketCount, dedupPct, avgRef, physicalRatio };
}

/** 公开 / 私有桶占比条的宽度百分比；没有桶时各占一半 */
export function calcPolicySplit(
  total: number,
  publicCount: number,
  privateCount: number
): { publicWidth: number; privateWidth: number } {
  if (total <= 0) return { publicWidth: 50, privateWidth: 50 };
  return { publicWidth: (publicCount * 100) / total, privateWidth: (privateCount * 100) / total };
}

/** 按可见性与桶名关键字（忽略大小写与首尾空白）筛选存储桶 */
export function filterBuckets(
  buckets: Bucket[],
  visFilter: VisibilityFilter,
  search: string
): Bucket[] {
  const keyword = search.trim().toLowerCase();
  return buckets.filter((b) => {
    if (visFilter !== 'all' && b.visibility !== visFilter) return false;
    if (keyword && !b.name.toLowerCase().includes(keyword)) return false;
    return true;
  });
}

/** 按已用容量从大到小排序（返回新数组，不修改入参） */
export function sortBucketsBySize(buckets: Bucket[]): Bucket[] {
  return [...buckets].sort((a, b) => b.usedBytes - a.usedBytes);
}

/** 占总逻辑容量的百分比；总量为 0 时返回 0。capAt100 为 true 时上限截断为 100 */
export function calcSharePercent(bytes: number, totalBytes?: number, capAt100 = false): number {
  if (!totalBytes || totalBytes <= 0) return 0;
  const pct = (bytes * 100) / totalBytes;
  return capAt100 ? Math.min(100, pct) : pct;
}

/** 存储桶表格中的容量进度：有配额按配额算，否则按总逻辑容量算（0~100 整数） */
export function calcBucketUsagePercent(bucket: Bucket, totalLogicalBytes?: number): number {
  if (bucket.quotaBytes > 0) {
    return Math.min(100, Math.round((bucket.usedBytes * 100) / bucket.quotaBytes));
  }
  if (totalLogicalBytes) {
    return Math.min(100, Math.round((bucket.usedBytes * 100) / totalLogicalBytes));
  }
  return 0;
}

/** 排行榜序号徽标的样式：前三名使用金 / 银 / 铜配色 */
export function getRankBadgeClass(index: number): string {
  if (index === 0) return 'bg-amber-100 text-amber-700';
  if (index === 1) return 'bg-slate-200 text-slate-700';
  if (index === 2) return 'bg-orange-100 text-orange-700';
  return 'bg-slate-100 text-slate-500';
}
