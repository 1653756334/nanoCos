import { useEffect } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { message } from 'antd';
import { StorageObject, cosApi } from '../../lib/api';
import { getErrorMessage, isUnauthorizedError } from '../../lib/errors';
import { queryKeys } from '../../lib/queryKeys';
import { useRefreshOverview } from '../system/queries';

export interface ObjectListParams {
  prefix: string;
  search: string;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: string;
}

export interface ObjectListResult {
  items: StorageObject[];
  breadcrumbs: string[];
  totalCount: number;
  loading: boolean;
  /** 最近一次成功拉取数据的时间戳，用于在数据刷新后清空多选 */
  dataUpdatedAt: number;
  refetch: () => void;
}

const EMPTY_ITEMS: StorageObject[] = [];
const EMPTY_CRUMBS: string[] = [];

/** 目录列表查询；切换目录/分页时保留上一页数据避免闪烁，失败时统一 toast */
export function useObjectList(bucket: string, params: ObjectListParams): ObjectListResult {
  const query = useQuery({
    queryKey: queryKeys.objects(bucket, params),
    queryFn: () =>
      cosApi.browseObjects(
        bucket,
        params.prefix,
        params.search,
        params.pageSize,
        (params.page - 1) * params.pageSize,
        params.sortBy || 'key',
        params.sortOrder || 'asc'
      ),
    enabled: !!bucket,
    placeholderData: keepPreviousData,
  });

  const { error } = query;
  useEffect(() => {
    if (error && !isUnauthorizedError(error)) {
      message.error(getErrorMessage(error, '加载对象列表失败'));
    }
  }, [error]);

  // 没有选中桶时不展示任何（可能来自 placeholder 的）旧数据
  const data = bucket ? query.data : undefined;
  return {
    items: data?.items ?? EMPTY_ITEMS,
    breadcrumbs: data?.breadcrumbs ?? EMPTY_CRUMBS,
    totalCount: data?.totalCount ?? data?.items?.length ?? 0,
    loading: query.isFetching,
    dataUpdatedAt: query.dataUpdatedAt,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** 使某个桶下的对象列表缓存失效；needOverview 为 true 时同时刷新桶统计（对象数 / 已用空间） */
export function useInvalidateObjects(bucket: string) {
  const queryClient = useQueryClient();
  const refreshOverview = useRefreshOverview();
  return async (options: { overview?: boolean } = {}) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.objectsOf(bucket) }),
      options.overview ? refreshOverview() : Promise.resolve(),
    ]);
  };
}

export function useCreateFolder(bucket: string) {
  const invalidate = useInvalidateObjects(bucket);
  return useMutation({
    mutationFn: (key: string) => cosApi.createFolder(bucket, key),
    onSuccess: () => invalidate(),
  });
}

/** 重命名 / 移动：基于 CAS 零拷贝的 copy + 删除源 */
export function useRenameObject(bucket: string) {
  const invalidate = useInvalidateObjects(bucket);
  return useMutation({
    mutationFn: (vars: { srcKey: string; dstKey: string }) =>
      cosApi.copyObject(bucket, {
        srcKey: vars.srcKey,
        dstBucket: bucket,
        dstKey: vars.dstKey,
        deleteSource: true,
      }),
    onSuccess: () => invalidate(),
  });
}

/** 依次删除多个对象（单个删除也走这里）；无论成败都刷新列表与桶统计，避免部分删除后界面陈旧 */
export function useDeleteObjects(bucket: string) {
  const invalidate = useInvalidateObjects(bucket);
  return useMutation({
    mutationFn: async (keys: string[]) => {
      for (const key of keys) {
        await cosApi.deleteObject(bucket, key);
      }
    },
    onSettled: () => invalidate({ overview: true }),
  });
}
