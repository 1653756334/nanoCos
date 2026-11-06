import { useState } from 'react';
import { Empty, Segmented } from 'antd';
import { ClockCircleOutlined, FileTextOutlined, FireOutlined } from '@ant-design/icons';
import type { SystemStats } from '../../../lib/api';
import { formatBytes, formatDate } from '../../../lib/utils';
import { calcSharePercent, getRankBadgeClass } from '../metrics';
import type { FeedMode } from '../types';

interface ObjectFeedPanelProps {
  stats: SystemStats | null;
  onOpenBucket: (bucketName: string) => void;
}

/** 右侧：Top 大文件容量排行 & 最近上传动态流 (5 列) */
export function ObjectFeedPanel({ stats, onOpenBucket }: ObjectFeedPanelProps) {
  const [feedMode, setFeedMode] = useState<FeedMode>('top');
  const feedItems = feedMode === 'top' ? stats?.topObjects || [] : stats?.recentObjects || [];

  return (
    <div className="lg:col-span-5 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
      <div>
        <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {feedMode === 'top' ? (
              <FireOutlined className="text-amber-500" />
            ) : (
              <ClockCircleOutlined className="text-blue-600" />
            )}
            <span className="text-sm font-semibold text-slate-800">
              {feedMode === 'top' ? 'Top 大文件容量排行' : '最近写入对象动态'}
            </span>
          </div>
          <Segmented
            size="small"
            value={feedMode}
            onChange={(v) => setFeedMode(v as FeedMode)}
            options={[
              { label: 'Top 大文件', value: 'top' },
              { label: '最新上传', value: 'recent' },
            ]}
          />
        </div>

        <div className="p-3.5">
          {feedItems.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无文件对象记录"
            />
          ) : (
            <div className="space-y-2.5">
              {feedItems.map((obj, idx) => {
                const sharePct = calcSharePercent(obj.sizeBytes, stats?.logicalBytes, true);
                return (
                  <div
                    key={`${obj.bucket}-${obj.key}`}
                    onClick={() => onOpenBucket(obj.bucket)}
                    className="group cursor-pointer p-2.5 rounded bg-slate-50/80 hover:bg-blue-50/50 border border-slate-200/70 hover:border-blue-200 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className={`w-5 h-5 rounded text-[11px] font-mono font-bold flex items-center justify-center shrink-0 ${getRankBadgeClass(idx)}`}
                        >
                          {idx + 1}
                        </span>
                        <FileTextOutlined className="text-slate-400 shrink-0" />
                        <span
                          className="font-mono font-medium text-slate-800 group-hover:text-blue-600 truncate"
                          title={obj.key}
                        >
                          {obj.key}
                        </span>
                      </div>
                      <span className="font-mono font-semibold text-slate-800 shrink-0">
                        {formatBytes(obj.sizeBytes)}
                      </span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-slate-400 pl-7">
                      <div className="flex items-center gap-2">
                        <span className="font-mono px-1.5 py-0.2 bg-white border border-slate-200 rounded text-slate-600">
                          {obj.bucket}
                        </span>
                        <span>{obj.contentType.split(';')[0]}</span>
                      </div>
                      <span className="font-mono">
                        {feedMode === 'top'
                          ? `占比 ${sharePct.toFixed(1)}%`
                          : formatDate(obj.updatedAt)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
