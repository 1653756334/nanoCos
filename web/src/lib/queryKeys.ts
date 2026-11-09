/**
 * TanStack Query 的 key 工厂。所有 queryKey 必须从这里取，禁止在业务代码中手写字面量数组。
 * 注意 objects 与 buckets 使用不同的顶层 key，避免刷新桶列表时误失效整个对象列表缓存。
 */
export const queryKeys = {
  me: ['auth', 'me'] as const,
  stats: ['system', 'stats'] as const,
  buckets: ['buckets'] as const,
  /** 某个桶下所有对象列表查询的公共前缀，用于整体失效 */
  objectsOf: (bucket: string) => ['objects', bucket] as const,
  objects: (
    bucket: string,
    params: {
      prefix: string;
      search: string;
      page: number;
      pageSize: number;
      sortBy?: string;
      sortOrder?: string;
    }
  ) => ['objects', bucket, params] as const,
  accessKeys: ['access-keys'] as const,
};
