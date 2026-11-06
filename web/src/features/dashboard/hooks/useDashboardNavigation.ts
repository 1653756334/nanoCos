import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { type ExplorerTab, routes } from '../../../lib/routes';

/** 仪表盘内的页面跳转：进入某个桶的文件管理 / 访问密钥页 */
export function useDashboardNavigation() {
  const navigate = useNavigate();

  const openBucket = useCallback(
    (bucketName: string, tab: ExplorerTab = 'objects') => navigate(routes.bucket(bucketName, tab)),
    [navigate]
  );
  const openKeys = useCallback(() => navigate(routes.keys), [navigate]);

  return { openBucket, openKeys };
}
