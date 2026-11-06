import { PieChartOutlined } from '@ant-design/icons';
import type { CategoryStat, SystemStats } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';
import { CategoryDonutChart } from './CategoryDonutChart';

interface CategoryBreakdownPanelProps {
  stats: SystemStats | null;
  categories: CategoryStat[];
}

/** 图表 1: 媒体类型容量分布环形图 (4 列) */
export function CategoryBreakdownPanel({ stats, categories }: CategoryBreakdownPanelProps) {
  return (
    <div className="lg:col-span-4 bg-white border border-slate-200 rounded-md flex flex-col justify-between">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PieChartOutlined className="text-blue-600" />
          <span className="text-sm font-semibold text-slate-800">
            文件类型容量构成 (Media Breakdown)
          </span>
        </div>
        <span className="text-[11px] font-mono text-slate-400">MIME 分布</span>
      </div>

      <div className="p-4 flex flex-col sm:flex-row items-center gap-4 flex-1">
        <CategoryDonutChart
          categories={categories}
          totalBytes={stats?.logicalBytes ?? 0}
          totalObjects={stats?.objectCount ?? 0}
        />
        <div className="flex-1 w-full space-y-2.5">
          {categories.map((cat) => (
            <div key={cat.category} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-slate-700 font-medium truncate">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: cat.color }}
                  />
                  <span className="truncate">{cat.label.split(' ')[0]}</span>
                </span>
                <span className="font-mono text-xs text-slate-800 font-semibold">
                  {formatBytes(cat.sizeBytes)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400 pl-4">
                <span>{cat.objectCount} 个对象</span>
                <span className="font-mono">{cat.percent.toFixed(1)}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
