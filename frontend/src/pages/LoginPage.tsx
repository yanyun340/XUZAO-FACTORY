import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { DropdownNav, type NavMenu } from '../components/DropdownNav';
import { BrandMark } from '../components/BrandMark';
import { Field, InlineNotice } from '../components/ui';
import { ArrowUpRight, CloseIcon } from '../components/Icons';

const DEMO_ACCOUNTS = [
  { username: 'admin', label: '管理员' },
  { username: 'logistics', label: '物流' },
  { username: 'production', label: '生产' },
  { username: 'qc', label: '品控' },
  { username: 'packing', label: '包装' },
];

const STEP_MS = 1800;
const FLOW = ['采购', '到货', '生产', '质检', '包装', '发货'];

export function LoginPage() {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [active, setActive] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const activeRef = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusPasswordRef = useRef(false);
  const glowRef = useRef<HTMLDivElement>(null);

  // 指针色斑：只写 transform，rAF 内做指数平滑，避免每帧触发样式重算
  useEffect(() => {
    const glow = glowRef.current;
    if (!glow) return;

    const canHover = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let frame = 0;
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;
    let primed = false;

    const render = () => {
      frame = 0;
      const dx = targetX - currentX;
      const dy = targetY - currentY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        currentX = targetX;
        currentY = targetY;
      } else {
        currentX += dx * 0.16;
        currentY += dy * 0.16;
        frame = window.requestAnimationFrame(render);
      }
      glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    };

    const handleMove = (event: PointerEvent) => {
      if (!canHover.matches || reduceMotion.matches) return;
      targetX = event.clientX;
      targetY = event.clientY;
      if (!primed) {
        primed = true;
        currentX = targetX;
        currentY = targetY;
        glow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
        glow.classList.add('is-active');
      }
      if (!frame) frame = window.requestAnimationFrame(render);
    };

    const handleLeave = () => {
      primed = false;
      glow.classList.remove('is-active');
    };

    window.addEventListener('pointermove', handleMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', handleLeave);
    window.addEventListener('blur', handleLeave);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      document.documentElement.removeEventListener('pointerleave', handleLeave);
      window.removeEventListener('blur', handleLeave);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  // 进入页面自动从 01 播到 06，播完停在 06；手动点击节点后同样暂停
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const next = activeRef.current + 1;
      if (next >= FLOW.length) {
        setPlaying(false);
        return;
      }
      activeRef.current = next;
      setActive(next);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing]);

  const selectStep = (index: number) => {
    setPlaying(false);
    activeRef.current = index;
    setActive(index);
  };

  /** 登录卡不再常驻：由导航或主按钮触发，弹层打开后再把焦点落到输入框。 */
  const openLogin = (presetUsername?: string) => {
    if (presetUsername) {
      setUsername(presetUsername);
      setPassword('');
      focusPasswordRef.current = true;
    }
    setError(null);
    setLoginOpen(true);
  };

  const closeLogin = () => {
    dialogRef.current?.close();
  };

  // 原生 dialog 负责焦点捕获与 Esc；这里只同步 showModal 与 React 状态
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (loginOpen && !dialog.open) {
      dialog.showModal();
      const targetId = focusPasswordRef.current ? 'password' : 'username';
      focusPasswordRef.current = false;
      window.requestAnimationFrame(() => document.getElementById(targetId)?.focus());
    }
  }, [loginOpen]);

  const handleDialogClose = () => {
    setLoginOpen(false);
  };

  const handleDialogClick = (event: ReactMouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current) closeLogin();
  };

  // 登录成功也停在首页：工作台只能从「进入系统」进入。
  // 若之前是被 RequireAuth 从某个内页踢回来的，进入系统后回到那一页。
  const from = (location.state as { from?: string } | null)?.from ?? '/orders';
  const enterTarget = from.startsWith('/') ? from : '/orders';

  const handleEnter = () => {
    if (user) {
      navigate(enterTarget, { replace: true });
      return;
    }
    openLogin();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }

    setSubmitting(true);
    try {
      await login(username.trim(), password);
      setSubmitting(false);
      setPassword('');
      closeLogin();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后重试');
      setSubmitting(false);
    }
  };

  const selectDemo = (value: string) => {
    openLogin(value);
  };

  const menus: NavMenu[] = [
    {
      id: 'flow',
      label: '功能',
      groups: [
        {
          heading: '订单主线',
          rows: [
            { title: '订单全链路', description: '一张订单贯穿采购、生产、质检、包装、发货' },
            { title: '采购与到货', description: '建采购单，按批次登记实收数量' },
            { title: '生产与报工', description: '按部门派工，现场报本工序完成量' },
            { title: '质检放行', description: '录入检验结果，管理员决定放行量' },
            { title: '包装与发货', description: '按剩余量登记，发货足量后自动完成' },
          ],
        },
      ],
    },
    {
      id: 'roles',
      label: '角色',
      groups: [
        {
          heading: '五个岗位 · 点击回填演示账号',
          rows: DEMO_ACCOUNTS.map((account) => ({
            title: account.label,
            description: `演示账号 ${account.username}`,
            onSelect: () => selectDemo(account.username),
          })),
        },
      ],
    },
    {
      id: 'deploy',
      label: '部署',
      groups: [
        {
          heading: '运行方式',
          rows: [
            { title: '本地部署', description: '服务与数据库都在厂内网络，不依赖公网' },
            { title: '演示数据', description: '当前实例为示范数据，可自由试用各角色' },
            { title: '权限与审计', description: '金额与联系方式按角色脱敏，写操作留痕' },
          ],
        },
      ],
    },
  ];

  return (
    <div className="landing">
      <div ref={glowRef} className="landing__glow" aria-hidden />

      <header className="landing__nav">
        <div className="login__nav-left">
          <div className="login__brand-top">
            <BrandMark className="brand__mark brand__mark--light" size={30} />
            <span className="login__brand-lockup">
              <strong className="login__brand-name">序造</strong>
              <span className="login__brand-latin mono" aria-hidden>
                XUZAO / FACTORY OS
              </span>
            </span>
          </div>
          <DropdownNav menus={menus} />
        </div>
        {user ? (
          <div className="landing__account">
            <span className="landing__account-name">{user.displayName}</span>
            <button
              type="button"
              className="landing__account-exit"
              onClick={() => void logout()}
            >
              退出登录
            </button>
          </div>
        ) : (
          <button type="button" className="landing__nav-cta" onClick={() => openLogin()}>
            登录
          </button>
        )}
      </header>

      <main className="landing__hero">
        <p className="landing__badge">
          <span className="landing__badge-dot" aria-hidden />
          本地部署 · 演示环境
        </p>
        <h1 className="landing__title">
          一单到底
          <span>全厂协同</span>
        </h1>
        <p className="landing__lede">
          <span className="login__lede-wide">
            从业务订单到发货完成，采购、生产、质检、包装、物流在同一条数据链上协作。
          </span>
          <span className="login__lede-narrow">订单到发货，全程在同一条数据链上协作。</span>
        </p>
        <button type="button" className="landing__hero-cta" onClick={handleEnter}>
          进入系统
        </button>
        {user ? (
          <p className="landing__signed-in" role="status">
            已登录为 {user.displayName} · 点击「进入系统」进入工作台
          </p>
        ) : null}
      </main>

      <section className="landing__stage" aria-label="订单流转演示">
        <div className="landing__demo">
          <p className="landing__demo-label">订单流转演示 · 点击任一环节</p>
          <div className="login__flowbar">
            <div className="flow" role="group" aria-label="订单流程演示，点击任意节点查看该环节">
              <div className="flow__rail">
                <span
                  className="flow__fill"
                  style={{ transform: `scaleX(${active / (FLOW.length - 1)})` }}
                />
                <span
                  className="flow__dot"
                  style={{ '--flow-p': active / (FLOW.length - 1) } as CSSProperties}
                />
              </div>
              <div className="flow__nodes">
                {FLOW.map((step, index) => (
                  <button
                    type="button"
                    key={step}
                    className={`flow__node${index < active ? ' is-done' : ''}${
                      index === active ? ' is-active' : ''
                    }`}
                    aria-label={`第 ${index + 1} 步：${step}`}
                    aria-pressed={index === active}
                    onClick={() => selectStep(index)}
                  >
                    <span className="flow__num">{String(index + 1).padStart(2, '0')}</span>
                    <span className="flow__mark" />
                    <span className="flow__label">{step}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className="landing__fineprint">
          序造 XuZao · 工厂业务协同管理系统 · 演示数据均为合成数据 · 本地部署
        </p>
      </section>

      <dialog
        ref={dialogRef}
        className="login-modal"
        aria-labelledby="login-title"
        onClose={handleDialogClose}
        onClick={handleDialogClick}
      >
        <div className="login-modal__card">
          <button type="button" className="login-modal__close" onClick={closeLogin} aria-label="关闭登录">
            <CloseIcon size={16} />
          </button>

          <aside className="login-modal__brand" aria-label="序造 XuZao">
            <BrandMark className="brand__mark" size={64} />
            <span className="login-modal__wordmark">
              <strong>序造</strong>
              <span className="mono">XUZAO / FACTORY OS</span>
            </span>
            <p className="login-modal__tagline">一单到底，全厂协同</p>
            <p className="login-modal__meta mono">本地部署 · 演示环境</p>
            <BrandMark className="login-modal__watermark" size={220} aria-hidden />
          </aside>

          <div className="login-modal__panel">
            <div className="login__card-head">
              <p className="eyebrow">SIGN IN / 工作台</p>
              <h2 className="login__card-title" id="login-title">
                登录工作台
              </h2>
              <p className="login__card-sub">使用分配给你的工厂角色账号登录，再从首页进入工作台。</p>
            </div>

            <form className="login__form" onSubmit={(event) => void handleSubmit(event)}>
              <Field label="用户名" htmlFor="username" required>
                <input
                  id="username"
                  className="input"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="例如 admin"
                />
              </Field>

              <Field label="密码" htmlFor="password" required>
                <div className="input-wrap">
                  <input
                    id="password"
                    className="input input--password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="输入登录密码"
                  />
                  <button
                    type="button"
                    className="input-reveal"
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? '隐藏' : '显示'}
                  </button>
                </div>
              </Field>

              {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

              <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
                <span className="btn__label">{submitting ? '正在验证…' : '登录'}</span>
                <span className="btn__trailing">
                  <ArrowUpRight size={16} />
                </span>
              </button>
            </form>

            <div className="login__demo">
              <p className="login__demo-label">演示账号</p>
              <div className="login__demo-chips">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    type="button"
                    key={account.username}
                    className={`chip${username === account.username ? ' chip--active' : ''}`}
                    onClick={() => {
                      setUsername(account.username);
                      setError(null);
                    }}
                  >
                    {account.label}
                    <code>{account.username}</code>
                  </button>
                ))}
              </div>
              <p className="login__demo-hint">密码见交付说明中的本地演示环境配置。</p>
            </div>
          </div>
        </div>
      </dialog>
    </div>
  );
}