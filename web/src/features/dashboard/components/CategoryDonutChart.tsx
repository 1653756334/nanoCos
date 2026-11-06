import type { CategoryStat } from '../../../lib/api';
import { formatBytes } from '../../../lib/utils';

interface CategoryDonutChartProps {
  categories: CategoryStat[];
  totalBytes: number;
  totalObjects: number;
}

// SVG 环形饼图组件：展示按文件类型的容量占比
export function CategoryDonutChart({ categories, totalBytes, totalObjects }: CategoryDonutChartProps) {
  const size = 148;
  const strokeWidth = 20;
  const center = size / 2;
  const radius = center - strokeWidth;
  const circumference = 2 * Math.PI * radius;

  let accumulatedPercent = 0;
  const hasData = totalBytes > 0 && categories.some((c) => c.sizeBytes > 0);

  return (
    <div className="relative flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        {/* 底环 */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="transparent"
          stroke="#f1f5f9"
          strokeWidth={strokeWidth}
        />
        {hasData &&
          categories.map((cat) => {
            if (cat.percent <= 0) return null;
            const strokeDasharray = `${(cat.percent / 100) * circumference} ${circumference}`;
            const strokeDashoffset = -((accumulatedPercent / 100) * circumference);
            accumulatedPercent += cat.percent;
            return (
              <circle
                key={cat.category}
                cx={center}
                cy={center}
                r={radius}
                fill="transparent"
                stroke={cat.color}
                strokeWidth={strokeWidth}
                strokeDasharray={strokeDasharray}
                strokeDashoffset={strokeDashoffset}
                className="transition-all duration-500"
              />
            );
          })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <span className="text-[11px] text-slate-400">总逻辑容量</span>
        <span className="text-sm font-bold font-mono text-slate-800 mt-0.5">
          {formatBytes(totalBytes)}
        </span>
        <span className="text-[10px] font-mono text-slate-400">
          {totalObjects} 个文件
        </span>
      </div>
    </div>
  );
}
