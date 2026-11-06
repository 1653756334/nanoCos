import { Menu, Progress } from 'antd';
import {
  DashboardOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  KeyOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { useLocation, useMatch, useNavigate } from 'react-router-dom';
import { NanoLogo } from '../../components/NanoLogo';
import { Bucket, SystemStats } from '../../lib/api';
import { routes } from '../../lib/routes';
import { formatBytes } from '../../lib/utils';

interface SidebarContentProps {
  collapsed: boolean;
  buckets: Bucket[];
  stats: SystemStats | null;
}

const NAV_ITEMS = [
  { key: routes.dashboard, icon: <DashboardOutlined />, label: '存储概览' },
  { key: routes.buckets, icon: <FolderOpenOutlined />, label: '存储桶与对象' },
  { key: routes.keys, icon: <KeyOutlined />, label: '访问密钥 & S3' },
];

/** 根据当前路径推导高亮的菜单项 */
function resolveActiveNav(pathname: string): string {
  if (pathname.startsWith(routes.buckets)) return routes.buckets;
  if (pathname.startsWith(routes.keys)) return routes.keys;
  return routes.dashboard;
}

export function SidebarContent({ collapsed, buckets, stats }: SidebarContentProps) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const bucketMatch = useMatch('/buckets/:bucket');
  const currentBucket = bucketMatch?.params.bucket
    ? decodeURIComponent(bucketMatch.params.bucket)
    : '';

  return (
    <div className="h-full flex flex-col justify-between">
      <div>
        {/* 顶部品牌栏 - 与右侧 Header 56px 严格对齐 */}
        <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <NanoLogo size={28} className="rounded shrink-0" />
            {!collapsed && (
              <div className="flex items-center gap-2">
                <span className="font-bold text-[15px] text-slate-900 tracking-tight">
                  NanoCOS
                </span>
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                  v1.0
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 主导航菜单 */}
        <div className="pt-3">
          {!collapsed && (
            <div className="px-4 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              控制台导航
            </div>
          )}
          <Menu
            mode="inline"
            selectedKeys={[resolveActiveNav(pathname)]}
            style={{ borderInlineEnd: 'none' }}
            onClick={({ key }) => navigate(key)}
            items={NAV_ITEMS}
          />
        </div>

        {/* 存储桶快捷列表 */}
        {!collapsed && (
          <BucketShortcutList
            buckets={buckets}
            currentBucket={currentBucket}
            onOpen={(name) => navigate(routes.bucket(name))}
          />
        )}
      </div>

      {/* 底部 CAS 物理存储水位卡片 */}
      {!collapsed && stats && <CasUsageCard stats={stats} />}
    </div>
  );
}

function BucketShortcutList({
  buckets,
  currentBucket,
  onOpen,
}: {
  buckets: Bucket[];
  currentBucket: string;
  onOpen: (name: string) => void;
}) {
  return (
    <div className="px-3 mt-5 pt-4 border-t border-slate-100">
      <div className="px-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
        <span>存储桶列表</span>
        <span className="font-mono">{buckets.length}</span>
      </div>
      <div className="space-y-0.5 max-h-64 overflow-y-auto">
        {buckets.length === 0 ? (
          <div className="px-2 py-2 text-xs text-slate-400">暂无存储桶</div>
        ) : (
          buckets.map((b) => {
            const isSelected = currentBucket === b.name;
            return (
              <button
                key={b.name}
                onClick={() => onOpen(b.name)}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs transition-colors ${
                  isSelected
                    ? 'bg-blue-50 text-blue-600 font-medium'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <div className="flex items-center gap-2 truncate">
                  {b.visibility === 'public-read' ? (
                    <GlobalOutlined className="text-emerald-600 shrink-0 text-xs" />
                  ) : (
                    <LockOutlined className="text-amber-600 shrink-0 text-xs" />
                  )}
                  <span className="font-mono truncate">{b.name}</span>
                </div>
                <span className="font-mono text-[11px] text-slate-400">{b.objectCount}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function CasUsageCard({ stats }: { stats: SystemStats }) {
  return (
    <div className="p-3 border-t border-slate-200 bg-slate-50/60">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-500">CAS 物理落盘</span>
          <span className="font-mono font-semibold text-slate-800">
            {formatBytes(stats.physicalBytes)}
          </span>
        </div>
        <Progress
          percent={Number(stats.dedupRatioPercent.toFixed(1))}
          size="small"
          strokeColor="#10b981"
          showInfo={false}
        />
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>去重已省 {formatBytes(stats.savedBytes)}</span>
          <span className="font-mono text-emerald-600 font-medium">
            {stats.dedupRatioPercent.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
