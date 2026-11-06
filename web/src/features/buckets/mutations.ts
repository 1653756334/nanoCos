import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cosApi } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { useRefreshOverview } from '../system/queries';

type CreateBucketPayload = Parameters<typeof cosApi.createBucket>[0];
type UpdateBucketPayload = Parameters<typeof cosApi.updateBucket>[1];

export function useCreateBucket() {
  const refresh = useRefreshOverview();
  return useMutation({
    mutationFn: (payload: CreateBucketPayload) => cosApi.createBucket(payload),
    onSuccess: () => refresh(),
  });
}

export function useUpdateBucket() {
  const refresh = useRefreshOverview();
  return useMutation({
    mutationFn: (vars: { name: string; payload: UpdateBucketPayload }) =>
      cosApi.updateBucket(vars.name, vars.payload),
    onSuccess: () => refresh(),
  });
}

export function useDeleteBucket() {
  const queryClient = useQueryClient();
  const refresh = useRefreshOverview();
  return useMutation({
    mutationFn: (vars: { name: string; force?: boolean }) =>
      cosApi.deleteBucket(vars.name, vars.force ?? true),
    onSuccess: async (_data, vars) => {
      queryClient.removeQueries({ queryKey: queryKeys.objectsOf(vars.name) });
      await refresh();
    },
  });
}
