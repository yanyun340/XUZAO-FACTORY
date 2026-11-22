import { BRAND_MARK_PATHS } from './BrandMark';

/**
 * 立方体的实际墨迹在 32 单位坐标系里是 x 5.61–26.39、y 4.81–27.19，
 * 也就是 22.38 单位高、中心在 (16, 16)。按字形墨迹高约 142 用户单位对齐：
 *   scale = 142 / 22.38 ≈ 6.35
 *   translate 让墨迹中心落在两字之间 (x=230) 与字形竖向中心 (y=67)
 */
const CUBE_SCALE = 5.45;
const CUBE_X = 232 - 16 * CUBE_SCALE;
const CUBE_Y = 67 - 16 * CUBE_SCALE;
/** 描边与字形同为 2 用户单位，换算回 32 单位坐标系。 */
const CUBE_STROKE = 2 / CUBE_SCALE;

/**
 * 落地页主字标：蓝图描边 + 立方体嵌入。
 *
 * 立方体不是并列的图标，而是两个字之间同高的一个「部件」——左右两侧分别是
 * 「序」「造」的描边字形，中间那条等距立方体承担结构上的连接。它与
 * BrandMark 共用同一份棱线数据，尺寸放大到与字同高，描边宽度换算回 2 用户单位。
 *
 * 落笔顺序：字形从左到右揭开（1s 匀速），结束后立方体逐棱描出。
 * 不用 stroke-dashoffset 描字：中文轮廓总长随字体回退浮动，终态不可控；
 * 立方体是自家路径，带 pathLength=1，可以放心用 dash 逐笔。
 */
export function BrandWordmark() {
  return (
    <div className="wordmark">
      <svg className="wordmark__svg" viewBox="0 0 460 175" role="img" aria-label="序造">
        <title>序造 XuZao</title>

        <g className="wordmark__glyphs">
          <text x="95" y="110" textAnchor="middle">
            序
          </text>
          <text x="372" y="110" textAnchor="middle">
            造
          </text>
        </g>

        <g
          className="wordmark__cube"
          transform={`translate(${CUBE_X} ${CUBE_Y}) scale(${CUBE_SCALE})`}
          strokeWidth={CUBE_STROKE}
          aria-hidden
        >
          {BRAND_MARK_PATHS.map((path, index) => (
            <path
              key={path.key}
              pathLength={1}
              d={path.d}
              style={{ animationDelay: `${1050 + index * 90}ms` }}
            />
          ))}
        </g>

        <g className="wordmark__dims" aria-hidden>
          <path d="M32 152 H436" />
          <path d="M32 146 V158" />
          <path d="M436 146 V158" />
          <path d="M27 -4 V138" />
          <path d="M21 -4 H33" />
          <path d="M21 138 H33" />
        </g>
      </svg>

      <span className="wordmark__pen" aria-hidden />
    </div>
  );
}