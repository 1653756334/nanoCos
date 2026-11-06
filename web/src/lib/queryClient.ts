import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 与改造前行为保持一致：失败不自动重试、切回窗口不自动刷新，由用户显式刷新
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 15_000,
      },
    },
  });
}
