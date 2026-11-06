import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { getErrorMessage, isUnauthorizedError } from '../../../lib/errors';
import { useAccessKeys, useDeleteAccessKey } from '../queries';

/** 密钥列表：加载、SecretKey 显隐状态、吊销操作 */
export function useAccessKeyList() {
  const query = useAccessKeys();
  const deleteMutation = useDeleteAccessKey();
  const [revealedSK, setRevealedSK] = useState<Record<string, boolean>>({});

  const keys = query.data ?? [];

  // 加载失败提示；会话过期（401）由全局登录守卫处理，这里不重复提示
  useEffect(() => {
    if (query.error && !isUnauthorizedError(query.error)) {
      message.error(getErrorMessage(query.error, '加载访问密钥失败'));
    }
  }, [query.error]);

  const toggleReveal = useCallback((accessKey: string) => {
    setRevealedSK((prev) => ({ ...prev, [accessKey]: !prev[accessKey] }));
  }, []);

  const deleteKey = useCallback(
    async (accessKey: string) => {
      try {
        await deleteMutation.mutateAsync(accessKey);
        message.success(`密钥 ${accessKey} 已吊销`);
      } catch (err: unknown) {
        message.error(getErrorMessage(err, '吊销密钥失败'));
      }
    },
    [deleteMutation]
  );

  return {
    keys,
    loading: query.isFetching,
    revealedSK,
    toggleReveal,
    deleteKey,
  };
}
