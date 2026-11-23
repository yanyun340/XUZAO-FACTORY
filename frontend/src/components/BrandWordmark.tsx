/**
 * 落地页主字标：蓝图描边 + 绘图机落笔。
 *
 * 立方体已经从字标里移出——落笔动画改由底部流程舞台的方块承接
 *（见 sandbox.css 的 sandboxPlot / sandboxFill）。两个字按正常字距并排，
 * 不再为中间的部件留空。
 *
 * 字形仍用遮罩从左到右揭开：中文轮廓总长随字体回退浮动，
 * 直接描 stroke 的终态不可控。
 */
export function BrandWordmark() {
  return (
    <div className="wordmark">
      <svg className="wordmark__svg" viewBox="0 0 460 175" role="img" aria-label="序造">
        <title>序造 XuZao</title>

        <g className="wordmark__glyphs">
          <text x="160" y="110" textAnchor="middle">
            序
          </text>
          <text x="300" y="110" textAnchor="middle">
            造
          </text>
        </g>

        <g className="wordmark__dims" aria-hidden>
          <path d="M88 152 H372" />
          <path d="M88 146 V158" />
          <path d="M372 146 V158" />
          <path d="M83 -4 V138" />
          <path d="M77 -4 H89" />
          <path d="M77 138 H89" />
        </g>
      </svg>

      <span className="wordmark__pen" aria-hidden />
    </div>
  );
}