import type { ReactNode } from 'react';

interface KpiCardProps {
  title: string;
  icon: ReactNode;
  /** 图标容器的颜色类（背景 / 边框 / 文字），需为完整的 Tailwind 类名 */
  iconClassName: string;
  /** 中部主数值行 */
  main: ReactNode;
  /** 底部进度条与说明行 */
  footer: ReactNode;
}

/** 指标卡外壳：严格等高 h-[148px]，由标题行、主数值行、底部说明行三段组成 */
export function KpiCard({ title, icon, iconClassName, main, footer }: KpiCardProps) {
  return (
    <div className="h-[148px] bg-white border border-slate-200 rounded-md p-4 flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500">{title}</span>
        <div className={`w-7 h-7 rounded ${iconClassName} flex items-center justify-center text-sm`}>
          {icon}
        </div>
      </div>
      <div className="flex items-baseline justify-between">{main}</div>
      <div>{footer}</div>
    </div>
  );
}
