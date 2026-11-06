import { BarChartOutlined } from '@ant-design/icons';
import type { Bucket, SystemStats } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';
import { calcSharePercent } from '../metrics';

/** 柱状条配色（按排名循环使用） */
const BAR_COLORS = ['#2563eb', '#0891b2', '#7c3aed', '#10b981'];

interface BucketUsagePanelProps {
  stats: SystemStats | null;
  /** 已按容量从大到小排序的存储桶 */
  sortedBuckets: Bucket[];
  totalBucketCount: number;
  onOpenBucket: (bucketName: string) => void;
}

/** 图表 2: 存储桶容量与对象占比柱状图 (4 列) */
export function BucketUsagePanel({
  stats,
  sortedBuckets,
  totalBucketCount,
  onOpenBucket,
}: BucketUsagePanelProps) {
  return (
    <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChartOutlined className="text-blue-600" />
          <span className="text-sm font-semibold text-slate-800">
            存储桶容量分布对比 (Bucket Usage)
          </span>
        </div>
        <span className="text-[11px] font-mono text-slate-400">Top Buckets</span>
      </div>

      <div className="p-4 flex-1 flex flex-col justify-between">
        {sortedBuckets.length === 0 ? (
          <div className="my-auto text-center text-xs text-slate-400 py-8">
            暂无存储桶数据
          </div>
        ) : (
          <div className="space-y-3">
            {sortedBuckets.slice(0, 4).map((b, idx) => {
              const sharePct = calcSharePercent(b.usedBytes, stats?.logicalBytes);
              const barColor = BAR_COLORS[idx % BAR_COLORS.length];
              return (
                <div
                  key={b.name}
                  onClick={() => onOpenBucket(b.name)}
                  className="group cursor-pointer space-y-1"
                >
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-semibold text-slate-800 group-hover:text-blue-600">
                        {b.name}
                      </span>
                      <span className="text-[11px] text-slate-400 font-mono">
                        ({b.objectCount} 项)
                      </span>
                    </div>
                    <div className="flex items-center gap-2 font-mono">
                      <span className="text-slate-800 font-medium">
                        {formatBytes(b.usedBytes)}
                      </span>
                      <span className="text-[11px] text-slate-400 w-11 text-right">
                        {sharePct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="h-2.5 w-full rounded bg-slate-100 overflow-hidden">
                    <div
                      className="h-full transition-all duration-500 rounded"
                      style={{
                        width: `${b.usedBytes > 0 ? Math.max(6, sharePct) : 0}%`,
                        backgroundColor: barColor,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-400">
          <span>点击任意桶柱状条可直达文件管理</span>
          <span className="font-mono text-slate-600">
            共 {totalBucketCount} 个桶
          </span>
        </div>
      </div>
    </div>
  );
}
