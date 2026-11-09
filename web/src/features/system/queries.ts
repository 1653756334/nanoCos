import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AuthMeResponse, Bucket, SystemStats, cosApi } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';

/**
 * 当前登录态。未登录（含 401 / 网络失败）统一返回 null，由 AuthGate 渲染登录页。
 */
export function useMe() {
  return useQuery<AuthMeResponse | null>({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return await cosApi.me();
      } catch {
        return null;
      }
    },
    staleTime: Infinity,
  });
}

export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: () => cosApi.getStats(),
  });
}

export function useBuckets() {
  return useQuery<Bucket[]>({
    queryKey: queryKeys.buckets,
    queryFn: async () => (await cosApi.listBuckets()).buckets || [],
  });
}

export interface SystemInfo {
  version: string;
  baseUrl: string;
  s3Endpoint: string;
  s3Region: string;
}

/** 对外访问地址 / S3 Endpoint / Region：优先取 stats，其次取 me，最后回退到当前页面 origin */
export function useSystemInfo(): SystemInfo {
  const { data: stats } = useStats();
  const { data: me } = useMe();
  const origin = window.location.origin;
  return {
    version: stats?.version || me?.version || 'v1.1.0',
    baseUrl: stats?.baseUrl || me?.baseUrl || origin,
    s3Endpoint: stats?.s3Endpoint || me?.s3Endpoint || `${origin}/s3`,
    s3Region: stats?.s3Region || me?.s3Region || 'us-east-1',
  };
}

export interface SystemOverview extends SystemInfo {
  stats: SystemStats | null;
  buckets: Bucket[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/** 仪表盘 / 侧边栏所需的「统计 + 桶列表」聚合视图 */
export function useSystemOverview(): SystemOverview {
  const statsQuery = useStats();
  const bucketsQuery = useBuckets();
  const info = useSystemInfo();
  const refresh = useRefreshOverview();
  return {
    ...info,
    stats: statsQuery.data?.stats ?? null,
    buckets: bucketsQuery.data ?? [],
    loading: statsQuery.isFetching || bucketsQuery.isFetching,
    refresh,
  };
}

/** 返回一个函数：使统计与桶列表缓存失效并等待重新拉取（对象 / 桶增删改后调用） */
export function useRefreshOverview(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.stats }),
      queryClient.invalidateQueries({ queryKey: queryKeys.buckets }),
    ]);
  }, [queryClient]);
}
