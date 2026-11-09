import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { cosApi } from '../../../lib/api';
import { getErrorMessage, isUnauthorizedError } from '../../../lib/errors';
import { copyToClipboard } from '../../../lib/utils';
import { useAccessKeys, useDeleteAccessKey } from '../queries';

/** 密钥列表：加载、按需获取明文 SecretKey、显隐状态与吊销操作 */
export function useAccessKeyList() {
  const query = useAccessKeys();
  const deleteMutation = useDeleteAccessKey();
  const [revealedSK, setRevealedSK] = useState<Record<string, boolean>>({});
  const [secretMap, setSecretMap] = useState<Record<string, string>>({});
  const [revealingMap, setRevealingMap] = useState<Record<string, boolean>>({});

  const keys = query.data ?? [];

  // 加载失败提示；会话过期（401）由全局登录守卫处理，这里不重复提示
  useEffect(() => {
    if (query.error && !isUnauthorizedError(query.error)) {
      message.error(getErrorMessage(query.error, '加载访问密钥失败'));
    }
  }, [query.error]);

  const ensureSecretKey = useCallback(
    async (accessKey: string): Promise<string | null> => {
      if (secretMap[accessKey]) {
        return secretMap[accessKey];
      }
      const existing = keys.find((k) => k.accessKey === accessKey)?.secretKey;
      if (existing) {
        setSecretMap((prev) => ({ ...prev, [accessKey]: existing }));
        return existing;
      }
      setRevealingMap((prev) => ({ ...prev, [accessKey]: true }));
      try {
        const res = await cosApi.revealAccessKey(accessKey);
        setSecretMap((prev) => ({ ...prev, [accessKey]: res.secretKey }));
        return res.secretKey;
      } catch (err: unknown) {
        message.error(getErrorMessage(err, '获取 SecretKey 明文失败'));
        return null;
      } finally {
        setRevealingMap((prev) => ({ ...prev, [accessKey]: false }));
      }
    },
    [keys, secretMap]
  );

  const toggleReveal = useCallback(
    async (accessKey: string) => {
      if (revealedSK[accessKey]) {
        setRevealedSK((prev) => ({ ...prev, [accessKey]: false }));
        return;
      }
      const sk = await ensureSecretKey(accessKey);
      if (sk) {
        setRevealedSK((prev) => ({ ...prev, [accessKey]: true }));
      }
    },
    [revealedSK, ensureSecretKey]
  );

  const copySecret = useCallback(
    async (accessKey: string) => {
      const sk = await ensureSecretKey(accessKey);
      if (!sk) return;
      await copyToClipboard(sk);
      message.success('SecretKey 已复制');
    },
    [ensureSecretKey]
  );

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
    secretMap,
    revealingMap,
    toggleReveal,
    copySecret,
    deleteKey,
  };
}
