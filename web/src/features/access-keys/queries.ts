import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AccessKeyItem, cosApi } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { useRefreshOverview } from '../system/queries';

/** 访问密钥列表 */
export function useAccessKeys() {
  return useQuery<AccessKeyItem[]>({
    queryKey: queryKeys.accessKeys,
    queryFn: async () => (await cosApi.listAccessKeys()).accessKeys || [],
  });
}

type CreateAccessKeyPayload = Parameters<typeof cosApi.createAccessKey>[0];

/** 签发新密钥；成功后刷新密钥列表与概览统计 */
export function useCreateAccessKey() {
  const queryClient = useQueryClient();
  const refreshOverview = useRefreshOverview();
  return useMutation({
    mutationFn: (payload: CreateAccessKeyPayload) => cosApi.createAccessKey(payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      await refreshOverview();
    },
  });
}

/** 吊销密钥；成功后刷新密钥列表与概览统计 */
export function useDeleteAccessKey() {
  const queryClient = useQueryClient();
  const refreshOverview = useRefreshOverview();
  return useMutation({
    mutationFn: (accessKey: string) => cosApi.deleteAccessKey(accessKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.accessKeys });
      await refreshOverview();
    },
  });
}
