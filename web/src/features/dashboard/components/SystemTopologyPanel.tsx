import { ClusterOutlined, CopyOutlined } from '@ant-design/icons';
import { message } from 'antd';
import type { SystemStats } from '../../../lib/api';
import { copyToClipboard, formatBytes } from '../../../lib/utils';

interface SystemTopologyPanelProps {
  stats: SystemStats | null;
  /** 块平均引用比（已格式化） */
  avgRef: string;
  baseUrl: string;
  s3Endpoint: string;
}

/** 图表 3: CAS 寻址引擎流水线拓扑 & 网关节点 (4 列) */
export function SystemTopologyPanel({ stats, avgRef, baseUrl, s3Endpoint }: SystemTopologyPanelProps) {
  // 三大协议入口
  const endpoints = [
    { tag: 'S3 节点', url: s3Endpoint },
    { tag: 'REST API', url: `${baseUrl}/api/v1` },
    { tag: 'Range 直链', url: `${baseUrl}/raw/{bucket}/{key}` },
  ];

  return (
    <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClusterOutlined className="text-blue-600" />
          <span className="text-sm font-semibold text-slate-800">
            CAS 寻址引擎拓扑与网关端点
          </span>
        </div>
        <span className="text-[11px] font-mono text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
          PathStyle: true
        </span>
      </div>

      <div className="p-4 flex-1 flex flex-col justify-between gap-3">
        {/* 拓扑流向图 */}
        <div className="grid grid-cols-3 gap-2 text-center bg-slate-50 border border-slate-200/80 rounded p-2.5">
          <div className="bg-white border border-slate-200 rounded p-2">
            <div className="text-[10px] text-slate-400">1. 逻辑对象层</div>
            <div className="text-sm font-bold font-mono text-blue-600 mt-0.5">
              {stats?.objectCount ?? 0}
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              {formatBytes(stats?.logicalBytes)}
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded p-2 flex flex-col items-center justify-center">
            <div className="text-[10px] text-slate-400">2. SHA256 映射</div>
            <div className="text-xs font-bold font-mono text-emerald-600 mt-0.5">
              {avgRef}x 聚合
            </div>
            <div className="text-[10px] text-slate-400">原子 Rename</div>
          </div>

          <div className="bg-white border border-slate-200 rounded p-2">
            <div className="text-[10px] text-slate-400">3. 物理块存储池</div>
            <div className="text-sm font-bold font-mono text-cyan-600 mt-0.5">
              {stats?.blobCount ?? 0}
            </div>
            <div className="text-[10px] font-mono text-slate-500">
              {formatBytes(stats?.physicalBytes)}
            </div>
          </div>
        </div>

        {/* 三大协议入口快捷复制列表 */}
        <div className="space-y-1.5">
          {endpoints.map((ep) => (
            <div
              key={ep.tag}
              className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded bg-slate-50 border border-slate-200/80 text-xs"
            >
              <div className="flex items-center gap-2 truncate">
                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600 shrink-0">
                  {ep.tag}
                </span>
                <code className="font-mono text-xs text-slate-700 truncate">
                  {ep.url}
                </code>
              </div>
              <button
                onClick={async () => {
                  await copyToClipboard(ep.url);
                  message.success(`${ep.tag} 地址已复制`);
                }}
                className="text-slate-400 hover:text-blue-600 shrink-0 cursor-pointer"
                title="复制地址"
              >
                <CopyOutlined />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
