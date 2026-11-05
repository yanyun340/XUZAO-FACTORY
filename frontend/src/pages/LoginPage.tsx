import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Field, InlineNotice } from '../components/ui';
import { ArrowUpRight } from '../components/Icons';

const DEMO_ACCOUNTS = [
  { username: 'admin', label: '管理员' },
  { username: 'logistics', label: '物流' },
  { username: 'production', label: '生产' },
  { username: 'qc', label: '品控' },
  { username: 'packing', label: '包装' },
];

export function LoginPage() {
  const { user, login, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!authLoading && user) {
    return <Navigate to="/orders" replace />;
  }

  const from = (location.state as { from?: string } | null)?.from ?? '/orders';

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
      navigate(from.startsWith('/') ? from : '/orders', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录失败，请稍后重试');
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <section className="login__brand" aria-label="序造 XuZao">
        <div className="login__brand-top">
          <span className="brand__mark brand__mark--light" aria-hidden>
            序
          </span>
          <span className="login__brand-name">序造 / XuZao</span>
        </div>

        <div className="login__statement">
          <p className="login__eyebrow">FACTORY COLLABORATION · 2026</p>
          <h1 className="login__title">
            一单
            <br />
            到底
          </h1>
          <p className="login__lede">
            从业务订单到发货完成，采购、生产、质检、包装、物流在同一条数据链上协作。
          </p>
        </div>

        <div className="login__brand-foot">
          <div className="login__flow" aria-hidden>
            {['采购', '到货', '生产', '质检', '包装', '发货'].map((step, index) => (
              <span className="login__flow-step" key={step}>
                <em>{String(index + 1).padStart(2, '0')}</em>
                {step}
              </span>
            ))}
          </div>
          <p className="login__fineprint">演示数据均为合成数据 · 本地部署</p>
        </div>
      </section>

      <section className="login__panel">
        <div className="bezelt">
          <div className="login__card">
            <div className="login__card-head">
              <p className="eyebrow">XUZAO / SIGN IN</p>
              <h2 className="login__card-title">登录工作台</h2>
              <p className="login__card-sub">使用分配给你的工厂角色账号进入系统。</p>
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
                <span className="btn__label">{submitting ? '正在验证…' : '进入工作台'}</span>
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

        <p className="login__footer">序造 XuZao · 工厂业务协同管理系统</p>
      </section>
    </div>
  );
}