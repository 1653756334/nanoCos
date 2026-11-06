interface NanoLogoProps {
  className?: string;
  size?: number;
}

/**
 * NanoCOS 极简现代几何 Logo (纯净透明底 · 霓虹电光青蓝折叠 N · 纳米数据节点)
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
        <linearGradient id="logoPrimary" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00F2FE" />
          <stop offset="35%" stopColor="#0284C7" />
          <stop offset="100%" stopColor="#2563EB" />
        </linearGradient>

        <linearGradient id="logoSecondary" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>

        <linearGradient id="logoParticle" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
      </defs>

      {/* 右侧数据立柱 (底图层) */}
      <path
        d="M 94 94 L 94 36"
        fill="none"
        stroke="url(#logoSecondary)"
        strokeWidth="18"
        strokeLinecap="round"
      />

      {/* 主 N 动态折叠流线 (左立柱 + 对角切线) */}
      <path
        d="M 34 94 L 34 34 L 94 94"
        fill="none"
        stroke="url(#logoPrimary)"
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 对角棱线质感高光 */}
      <path
        d="M 36 34 L 92 92"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeOpacity="0.35"
      />

      {/* 纳米数据粒子节点 */}
      <circle cx="104" cy="22" r="8" fill="url(#logoParticle)" />
      <circle cx="104" cy="22" r="3.5" fill="#FFFFFF" />
    </svg>
  );
}
