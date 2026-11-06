interface NanoLogoProps {
  className?: string;
  size?: number;
}

/**
 * NanoCOS 方案 C Logo: 无限数据流 (Infinity Stream · 莫比乌斯环 · CAS 永续流动)
 */
export function NanoLogo({ className = '', size = 28 }: NanoLogoProps) {
  return (
    <svg
      viewBox="0 0 128 128"
      width={size}
      height={size}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* 无限流光主渐变：赛博青 -> 极速天蓝 -> 核心科技蓝 -> 曜石极光紫 */}
        <linearGradient id="nanoInfGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00F2FE" />
          <stop offset="35%" stopColor="#38BDF8" />
          <stop offset="70%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#8B5CF6" />
        </linearGradient>

        {/* 交叉处立体阴影渐变 */}
        <linearGradient id="nanoCrossShadow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#1E1B4B" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#1E1B4B" stopOpacity="0" />
        </linearGradient>

        <filter id="nanoGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* 1. 底层穿透光轨 (后环) */}
      <path
        d="M 42 42 C 20 42 20 86 42 86 C 58 86 70 42 86 42 C 108 42 108 86 86 86 C 70 86 58 42 42 42 Z"
        stroke="url(#nanoInfGrad)"
        strokeWidth="15"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* 2. 前景立体跨越遮罩线 (立体咬合穿插) */}
      <path
        d="M 50 72 C 58 86 70 42 78 56"
        stroke="url(#nanoInfGrad)"
        strokeWidth="15"
        strokeLinecap="round"
        fill="none"
      />

      {/* 3. 交叉点景深遮蔽 */}
      <circle cx="64" cy="64" r="9" fill="url(#nanoCrossShadow)" opacity="0.4" />

      {/* 4. 纳米级量子数据节点 (象征 CAS 内容寻址与对象原子核心) */}
      <circle cx="64" cy="64" r="5" fill="#00F2FE" filter="url(#nanoGlow)" />
      <circle cx="64" cy="64" r="2.2" fill="#FFFFFF" />
    </svg>
  );
}
