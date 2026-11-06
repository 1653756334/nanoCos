import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';

/**
 * 清除前端会话态：丢弃除登录态外的全部业务缓存（避免下一位用户登录后短暂看到旧数据），
 * 并把登录态置空，使 AuthGate 渲染登录页。
 */
export function clearSession(queryClient: QueryClient): void {
  queryClient.removeQueries({
    predicate: (q) => q.queryKey[0] !== queryKeys.me[0],
  });
  queryClient.setQueryData(queryKeys.me, null);
}
