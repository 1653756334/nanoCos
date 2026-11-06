import { Badge, Button, Space } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { formatUptime } from '../format';

interface DashboardHeaderProps {
  uptimeSeconds?: number;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
}

/** 顶部监控大盘工具栏：标题、引擎运行状态、刷新与新建按钮 */
export function DashboardHeader({ uptimeSeconds, loading, onRefresh, onCreate }: DashboardHeaderProps) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-white border border-slate-200 rounded-md px-5 py-3.5">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-base font-bold text-slate-900 m-0">
          存储监控与分析大盘 (Storage Telemetry &amp; Analytics)
        </h1>
        <Badge
          status="processing"
          text={
            <span className="text-xs text-slate-500 font-mono">
              Engine: SQLite WAL + CAS SHA-256 · 已运行 {formatUptime(uptimeSeconds)}
            </span>
          }
        />
      </div>
      <Space size={8}>
        <Button icon={<ReloadOutlined spin={loading} />} onClick={onRefresh}>
          刷新监控
        </Button>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
          新建存储桶
        </Button>
      </Space>
    </div>
  );
}
