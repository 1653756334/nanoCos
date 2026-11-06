export type ExplorerTab = 'objects' | 'settings' | 'guide';

export const EXPLORER_TABS: readonly ExplorerTab[] = ['objects', 'settings', 'guide'];

export function parseExplorerTab(value: string | null | undefined): ExplorerTab {
  return EXPLORER_TABS.includes(value as ExplorerTab) ? (value as ExplorerTab) : 'objects';
}

/**
 * 路由路径构造。后端对 /api、/raw、/s3 前缀有保留，前端路由不得使用这些前缀。
 */
export const routes = {
  dashboard: '/',
  keys: '/keys',
  /** 存储桶入口（未指定桶时由页面重定向到第一个桶） */
  buckets: '/buckets',
  bucket: (name: string, tab: ExplorerTab = 'objects') =>
    `/buckets/${encodeURIComponent(name)}${tab === 'objects' ? '' : `?tab=${tab}`}`,
} as const;
