/**
 * 落地页主字标：蓝图描边 + 绘图机落笔。
 *
 * 不用 stroke-dashoffset：中文轮廓总长随字体回退（PingFang / 微软雅黑 / 思源）
 * 浮动，dasharray 设小会留断口、设大会提前画完。这里用 clip-path 从左向右
 * 揭开描边层，终态由 inset(0) 硬保证完整，与字体无关；前沿一根细线充当笔尖。
 *
 * 尺寸标注画在同一个 viewBox 里，随字形等比缩放，不会与字脱开。
 * 只画刻度与端帽，不标数字——页面上不出现编造的测量值。
 */
export function BrandWordmark() {
  return (
    <div className="wordmark">
      <svg className="wordmark__svg" viewBox="0 0 360 170" role="img" aria-label="序造">
        <title>序造 XuZao</title>

        <text x="180" y="110" textAnchor="middle" className="wordmark__glyph">
          序造
        </text>

        <g className="wordmark__dims" aria-hidden>
          {/* 横向：字底下方 14 单位 */}
          <path d="M53 152 H308" />
          <path d="M53 146 V158" />
          <path d="M308 146 V158" />
          {/* 纵向：字左侧 9 单位 */}
          <path d="M44 -4 V138" />
          <path d="M38 -4 H50" />
          <path d="M38 138 H50" />
        </g>
      </svg>

      <span className="wordmark__pen" aria-hidden />
    </div>
  );
}