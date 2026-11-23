import { useRef, useState, type KeyboardEvent } from 'react';
import {
  CartIcon,
  GaugeIcon,
  GearIcon,
  InboxIcon,
  PackageIcon,
  TruckIcon,
} from './Icons';

export type FlowFace = 'front' | 'right' | 'back' | 'left' | 'top' | 'bottom';

export interface FlowStage {
  id: string;
  /** 进度条上的短标签 */
  label: string;
  /** 对应立方体的哪一面 */
  face: FlowFace;
  icon: 'cart' | 'inbox' | 'gear' | 'gauge' | 'package' | 'truck';
  /** 信息卡标题 */
  title: string;
  /** 信息卡正文 */
  detail: string;
  /** 信息卡右侧的对内提示，例如单据类型 */
  note: string;
}

/** 六个工序，改文案只改这里。 */
export const FLOW_STAGES: FlowStage[] = [
  {
    id: 'purchase',
    label: '采购',
    face: 'front',
    icon: 'cart',
    title: '采购下单',
    detail: '按订单需求量生成采购单，供应商、单价与到货批次一次登记。',
    note: '采购单',
  },
  {
    id: 'arrival',
    label: '到货',
    face: 'right',
    icon: 'inbox',
    title: '到货验收',
    detail: '按批次登记实收数量，不足部分保留在采购单上继续跟踪。',
    note: '到货单',
  },
  {
    id: 'production',
    label: '生产',
    face: 'back',
    icon: 'gear',
    title: '生产报工',
    detail: '任务下发到具体部门，现场按工序报完成量，进度实时回到订单。',
    note: '工单',
  },
  {
    id: 'qc',
    label: '质检',
    face: 'left',
    icon: 'gauge',
    title: '质检放行',
    detail: '录入检验结果，管理员按合格量决定放行数量，不合格部分留待处理。',
    note: '检验单',
  },
  {
    id: 'packing',
    label: '包装',
    face: 'top',
    icon: 'package',
    title: '包装入库',
    detail: '按放行剩余量登记包装，包装数与放行数逐单对账。',
    note: '包装单',
  },
  {
    id: 'shipping',
    label: '发货',
    face: 'bottom',
    icon: 'truck',
    title: '发货出库',
    detail: '发货足量后订单自动完成，物流与交期差异汇总到同一张单上。',
    note: '发货单',
  },
];

export const SANDBOX_COPY = {
  eyebrow: '流程沙盘',
  hint: '点击任一面或下方节点',
};

const ICONS = {
  cart: CartIcon,
  inbox: InboxIcon,
  gear: GearIcon,
  gauge: GaugeIcon,
  package: PackageIcon,
  truck: TruckIcon,
} as const;

/**
 * 等距基础角 + 每个面的 90° 整数倍。
 * 不用正对镜头：正对时相邻两面会退化成一条线，看不出「当前面亮、邻面变暗」。
 */
const BASE_RX = -24;
const BASE_RY = -32;

const CUBE_VIEW: Record<FlowFace, { rx: number; ry: number }> = {
  front: { rx: 0, ry: 0 },
  right: { rx: 0, ry: -90 },
  back: { rx: 0, ry: 180 },
  left: { rx: 0, ry: 90 },
  /* 面自身是 rotateX(±90) 摆上去的，要把它转到正面就得反向旋转 */
  top: { rx: -90, ry: 0 },
  bottom: { rx: 90, ry: 0 },
};

export function LandingFlowSandbox() {
  const [active, setActive] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stage = FLOW_STAGES[active];
  const view = CUBE_VIEW[stage.face];

  const focusTab = (index: number) => {
    setActive(index);
    tabRefs.current[index]?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = FLOW_STAGES.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    focusTab(next);
  };

  return (
    <section className="sandbox" aria-label="订单流程沙盘">
      <p className="sandbox__eyebrow">
        <span className="sandbox__eyebrow-dot" aria-hidden />
        {SANDBOX_COPY.eyebrow}
        <span className="sandbox__hint">{SANDBOX_COPY.hint}</span>
      </p>

      <div className="sandbox__stage">
        <div
          className="sandbox__cube"
          style={{
            /* 先等距，再乘上面朝向的逆矩阵：CSS 是矩阵相乘，不能把角度相加 */
            transform: `rotateX(${BASE_RX}deg) rotateY(${BASE_RY}deg) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`,
          }}
        >
          {FLOW_STAGES.map((item, index) => {
            const Icon = ICONS[item.icon];
            return (
              <button
                key={item.id}
                type="button"
                className={`sandbox__face sandbox__face--${item.face}`}
                data-state={index === active ? 'active' : 'idle'}
                aria-label={`查看${item.title}`}
                tabIndex={-1}
                onClick={() => setActive(index)}
              >
                <span className="sandbox__icon">
                  <Icon size={26} />
                </span>
                <span className="sandbox__face-label">{item.label}</span>
                {/* 光带挂在面上，跟着面的 3D 变换走，才有「沿边流动」的透视感 */}
                {index === active ? <span className="sandbox__spark" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sandbox__tabs" role="tablist" aria-label="流程阶段">
        {FLOW_STAGES.map((item, index) => (
          <button
            key={item.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`sandbox-tab-${item.id}`}
            aria-selected={index === active}
            aria-controls="sandbox-panel"
            tabIndex={index === active ? 0 : -1}
            className="sandbox__tab"
            data-state={index === active ? 'active' : 'idle'}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            <span className="sandbox__tab-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="sandbox__tab-label">{item.label}</span>
          </button>
        ))}
      </div>

      <div
        key={stage.id}
        id="sandbox-panel"
        role="tabpanel"
        aria-labelledby={`sandbox-tab-${stage.id}`}
        aria-live="polite"
        className="sandbox__card"
      >
        <div className="sandbox__card-head">
          <h3 className="sandbox__card-title">{stage.title}</h3>
          <span className="sandbox__card-note mono">{stage.note}</span>
        </div>
        <p className="sandbox__card-detail">{stage.detail}</p>
      </div>
    </section>
  );
}