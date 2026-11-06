import {
  DatabaseOutlined,
  HddOutlined,
  ThunderboltOutlined,
  KeyOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import type { Bucket, SystemStats } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';
import { calcPolicySplit, type DashboardSummary } from '../metrics';
import { KpiCard } from './KpiCard';

interface StatCardsProps {
  stats: SystemStats | null;
  buckets: Bucket[];
  summary: DashboardSummary;
  onNavigateKeys: () => void;
}

/** 第一排：4 张带微图表的高密度数字指标卡 (严格等高 h-[148px]) */
export function StatCards({ stats, buckets, summary, onNavigateKeys }: StatCardsProps) {
  const { categories, publicBucketCount, privateBucketCount, dedupPct, avgRef, physicalRatio } = summary;
  const { publicWidth, privateWidth } = calcPolicySplit(
    buckets.length,
    publicBucketCount,
    privateBucketCount
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {/* KPI 1: 逻辑存储总量 + 多彩分类光谱条 */}
      <KpiCard
        title="逻辑存储总容量 (Logical Capacity)"
        icon={<DatabaseOutlined />}
        iconClassName="bg-blue-50 border border-blue-100 text-blue-600"
        main={
          <>
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {formatBytes(stats?.logicalBytes)}
            </span>
            <span className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
              {(stats?.objectCount ?? 0).toLocaleString()} 文件 / {(stats?.folderCount ?? 0).toLocaleString()} 目录
            </span>
          </>
        }
        footer={
          <>
            {/* 分类占比光谱条 */}
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden flex mb-2">
              {categories.map((c) =>
                c.percent > 0 ? (
                  <div
                    key={c.category}
                    style={{ width: `${c.percent}%`, backgroundColor: c.color }}
                    title={`${c.label}: ${formatBytes(c.sizeBytes)} (${c.percent.toFixed(1)}%)`}
                  />
                ) : null
              )}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>跨存储桶逻辑汇总</span>
              <span className="font-mono text-slate-600">{buckets.length} Active Buckets</span>
            </div>
          </>
        }
      />

      {/* KPI 2: 物理磁盘占用 + 逻辑/物理双层对比条 */}
      <KpiCard
        title="CAS 物理磁盘落盘 (Physical Footprint)"
        icon={<HddOutlined />}
        iconClassName="bg-cyan-50 border border-cyan-100 text-cyan-600"
        main={
          <>
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {formatBytes(stats?.physicalBytes)}
            </span>
            <span className="text-xs font-mono text-cyan-600 bg-cyan-50 px-1.5 py-0.5 rounded border border-cyan-100">
              {(stats?.blobCount ?? 0).toLocaleString()} 独立物理块
            </span>
          </>
        }
        footer={
          <>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden mb-2">
              <div
                className="h-full bg-cyan-500 transition-all"
                style={{ width: `${stats?.physicalBytes ? physicalRatio : 0}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>物理/逻辑落盘比</span>
              <span className="font-mono text-slate-600">{physicalRatio}% 磁盘占空比</span>
            </div>
          </>
        }
      />

      {/* KPI 3: CAS 去重节省与引用复用率 */}
      <KpiCard
        title="CAS 去重与秒传收益 (Deduplication)"
        icon={<ThunderboltOutlined />}
        iconClassName="bg-emerald-50 border border-emerald-100 text-emerald-600"
        main={
          <>
            <span className="text-2xl font-bold font-mono text-emerald-600 leading-none">
              {formatBytes(stats?.savedBytes)}
            </span>
            <span className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-200">
              去重率 {dedupPct}%
            </span>
          </>
        }
        footer={
          <>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden mb-2">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${Math.min(100, dedupPct)}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>块平均引用比 (Ref Ratio)</span>
              <span className="font-mono text-emerald-600 font-semibold">{avgRef}x 复用</span>
            </div>
          </>
        }
      />

      {/* KPI 4: 访问安全与协议网关状态 */}
      <KpiCard
        title="安全策略与访问凭证 (Security &amp; Auth)"
        icon={<KeyOutlined />}
        iconClassName="bg-amber-50 border border-amber-100 text-amber-600"
        main={
          <>
            <span className="text-2xl font-bold font-mono text-slate-900 leading-none">
              {stats?.accessKeyCount ?? 0}{' '}
              <span className="text-xs font-sans font-normal text-slate-500">组密钥</span>
            </span>
            <button
              onClick={onNavigateKeys}
              className="text-xs text-blue-600 hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>管理密钥</span>
              <ArrowRightOutlined className="text-[10px]" />
            </button>
          </>
        }
        footer={
          <>
            <div className="h-2 w-full rounded bg-slate-100 overflow-hidden flex mb-2">
              <div className="h-full bg-emerald-500" style={{ width: `${publicWidth}%` }} />
              <div className="h-full bg-amber-500" style={{ width: `${privateWidth}%` }} />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>桶策略: {publicBucketCount} 公开 / {privateBucketCount} 私有</span>
              <span className="font-mono text-slate-600">
                {stats?.multipartActiveCount ?? 0} 分片传输中
              </span>
            </div>
          </>
        }
      />
    </div>
  );
}
