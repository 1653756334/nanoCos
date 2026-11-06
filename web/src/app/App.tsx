import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AccessKeysPage } from '../features/access-keys/AccessKeysPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { ExplorerPage } from '../features/explorer/ExplorerPage';
import { AuthGate } from './AuthGate';
import { AppLayout } from './layout/AppLayout';
import { appTheme } from './theme';

export default function App() {
  return (
    <ConfigProvider locale={zhCN} theme={appTheme}>
      <AuthGate>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<DashboardPage />} />
            <Route path="buckets" element={<ExplorerPage />} />
            <Route path="buckets/:bucket" element={<ExplorerPage />} />
            <Route path="keys" element={<AccessKeysPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGate>
    </ConfigProvider>
  );
}
