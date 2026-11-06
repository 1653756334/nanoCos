import { ReactNode, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Spin, message } from 'antd';
import { LoginPage } from '../features/auth/LoginPage';
import { clearSession } from '../features/auth/session';
import { useMe } from '../features/system/queries';
import { queryKeys } from '../lib/queryKeys';

/**
 * 登录态守卫：
 * - 登录态检查中显示 loading；
 * - 未登录渲染登录页；
 * - 已登录渲染子节点。
 * 任意请求返回 401 时 api.ts 会广播 `cos:unauthorized`，这里统一清空缓存并回到登录页。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: me, isPending } = useMe();

  useEffect(() => {
    const onUnauthorized = () => {
      if (queryClient.getQueryData(queryKeys.me)) {
        message.warning('登录会话已过期，请重新登录');
      }
      clearSession(queryClient);
    };
    window.addEventListener('cos:unauthorized', onUnauthorized);
    return () => window.removeEventListener('cos:unauthorized', onUnauthorized);
  }, [queryClient]);

  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f7fa]">
        <Spin size="large" />
      </div>
    );
  }

  if (!me) {
    return (
      <LoginPage
        onSuccess={async () => {
          await queryClient.refetchQueries({ queryKey: queryKeys.me });
        }}
      />
    );
  }

  return <>{children}</>;
}
