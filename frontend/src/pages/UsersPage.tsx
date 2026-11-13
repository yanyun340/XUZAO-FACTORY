import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiGetPage, apiPatch, apiPost } from '../api/client';
import type { Department, ManagedUser, PageMeta, Role } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PlusIcon } from '../components/Icons';
import { Button, EmptyState, InlineNotice, LoadingBlock } from '../components/ui';
import { useModalFocus } from '../hooks/useModalFocus';
import { ROLE_LABEL } from '../lib/format';

const ROLES: Role[] = ['ADMIN', 'LOGISTICS', 'PRODUCTION', 'QC', 'PACKING'];

type ModalState =
  | { mode: 'create' }
  | { mode: 'edit'; user: ManagedUser }
  | { mode: 'password'; user: ManagedUser }
  | null;

export function UsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 弹窗表单
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('ADMIN');
  const [departmentId, setDepartmentId] = useState('');
  const [active, setActive] = useState(true);

  const cardRef = useModalFocus(modal !== null, () => setModal(null), {
    canClose: () => !busy,
  });

  useEffect(() => {
    let cancelled = false;
    apiGetPage<ManagedUser[]>('/users?page=1&pageSize=100')
      .then((result) => {
        if (cancelled) return;
        setUsers(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : '账号列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    apiGetPage<Department[]>('/departments')
      .then((result) => {
        if (!cancelled) setDepartments(result.data);
      })
      .catch(() => {
        // 部门下拉失败不影响账号列表
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const openCreate = () => {
    setUsername('');
    setPassword('');
    setDisplayName('');
    setRole('QC');
    setDepartmentId('');
    setActive(true);
    setFormError(null);
    setModal({ mode: 'create' });
  };

  const openEdit = (target: ManagedUser) => {
    setDisplayName(target.displayName);
    setRole(target.role);
    setDepartmentId(target.department?.id ?? '');
    setActive(target.active);
    setFormError(null);
    setModal({ mode: 'edit', user: target });
  };

  const openPassword = (target: ManagedUser) => {
    setPassword('');
    setFormError(null);
    setModal({ mode: 'password', user: target });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!modal) return;

    setBusy(true);
    setFormError(null);
    try {
      if (modal.mode === 'create') {
        if (password.length < 8) {
          setFormError('密码至少 8 位');
          return;
        }
        await apiPost('/users', {
          username: username.trim(),
          password,
          displayName: displayName.trim(),
          role,
          departmentId: departmentId || null,
        });
        setNotice(`账号 ${username.trim()} 已创建`);
      } else if (modal.mode === 'edit') {
        const result = await apiPatch<{ sessionsRevoked: boolean }>(`/users/${modal.user.id}`, {
          displayName: displayName.trim(),
          role,
          departmentId: departmentId || null,
          active,
        });
        setNotice(
          result.sessionsRevoked
            ? `已保存，${modal.user.displayName} 的登录会话已全部失效`
            : `已保存 ${modal.user.displayName} 的账号信息`,
        );
      } else {
        if (password.length < 8) {
          setFormError('密码至少 8 位');
          return;
        }
        await apiPost(`/users/${modal.user.id}/password`, { password });
        setNotice(`已重置 ${modal.user.displayName} 的密码，旧会话已失效`);
      }
      setModal(null);
      reload();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : '保存失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const revokeSessions = async (target: ManagedUser) => {
    setError(null);
    try {
      const result = await apiPost<{ revoked: number }>(`/users/${target.id}/revoke-sessions`);
      setNotice(`已吊销 ${target.displayName} 的 ${result.revoked} 个会话`);
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '吊销会话失败');
    }
  };

  const toggleActive = async (target: ManagedUser) => {
    setError(null);
    try {
      const result = await apiPatch<{ sessionsRevoked: boolean }>(`/users/${target.id}`, {
        active: !target.active,
      });
      setNotice(
        target.active
          ? `已停用 ${target.displayName}，其会话已失效`
          : `已启用 ${target.displayName}${result.sessionsRevoked ? '（需重新登录）' : ''}`,
      );
      reload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败');
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head__copy">
          <p className="eyebrow">ACCOUNTS / 账号</p>
          <h1 className="page-title">账号管理</h1>
          <p className="page-lede">
            建账号、改角色、停用与重置密码。角色或状态一变，已签发的会话立刻失效，不用等 Cookie 过期。
          </p>
        </div>
        <div className="page-head__action">
          <Button onClick={openCreate} trailing={<PlusIcon size={16} />}>
            新建账号
          </Button>
        </div>
      </header>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? (
        <InlineNotice tone="info">
          <span>{notice}</span>
          <button type="button" className="notice__retry" onClick={() => setNotice(null)}>
            知道了
          </button>
        </InlineNotice>
      ) : null}

      <section className="panel" aria-busy={loading}>
        <div className="panel__head">
          <div>
            <h2 className="panel__title">全部账号</h2>
            <p className="panel__meta">{meta ? `共 ${meta.total} 个` : '读取中'}</p>
          </div>
        </div>

        {loading ? (
          <LoadingBlock lines={5} />
        ) : users.length === 0 ? (
          <EmptyState title="还没有账号" description="点击右上角新建账号。" />
        ) : (
          <>
            <p className="data-table__hint">左右滑动查看全部列 ›</p>
            <div className="user-table">
            <div className="user-table__head" aria-hidden>
              <span>姓名 / 用户名</span>
              <span>角色</span>
              <span>部门</span>
              <span>状态</span>
              <span>会话</span>
              <span>操作</span>
            </div>

            {users.map((item) => {
              const isSelf = item.id === currentUser?.id;
              return (
                <div className="user-row" key={item.id}>
                  <span className="user-row__name">
                    <strong>
                      {item.displayName}
                      {isSelf ? <em className="user-row__self">本人</em> : null}
                    </strong>
                    <small className="mono">{item.username}</small>
                  </span>
                  <span>
                    <span className={`role-pill role-pill--${item.role.toLowerCase()}`}>
                      {ROLE_LABEL[item.role]}
                    </span>
                  </span>
                  <span className="user-row__dept">{item.department?.name ?? '—'}</span>
                  <span>
                    <span className={`user-row__state${item.active ? ' is-on' : ' is-off'}`}>
                      {item.active ? '启用' : '停用'}
                    </span>
                  </span>
                  <span className="user-row__sessions mono">{item.activeSessions}</span>
                  <span className="user-row__actions">
                    <button type="button" className="text-btn" onClick={() => openEdit(item)}>
                      编辑
                    </button>
                    <button type="button" className="text-btn" onClick={() => openPassword(item)}>
                      密码
                    </button>
                    <button
                      type="button"
                      className="text-btn text-btn--danger"
                      onClick={() => void revokeSessions(item)}
                      disabled={item.activeSessions === 0}
                    >
                      吊销
                    </button>
                    <button
                      type="button"
                      className={`text-btn${item.active ? ' text-btn--danger' : ''}`}
                      onClick={() => void toggleActive(item)}
                      disabled={isSelf}
                    >
                      {item.active ? '停用' : '启用'}
                    </button>
                  </span>
                </div>
              );
            })}
            </div>
          </>
        )}
      </section>

      <p className="role-note">
        建号时间最早的一批来自演示种子数据；账号信息只在本机数据库，不包含任何真实员工资料。
      </p>

      {modal
        ? createPortal(
            <div className="modal" role="dialog" aria-modal="true" aria-label="账号">
              <button
                type="button"
                className="modal__backdrop"
                aria-label="关闭"
                onClick={() => setModal(null)}
              />
              <form ref={cardRef} className="modal__card" onSubmit={(event) => void submit(event)}>
                <p className="eyebrow">
                  {modal.mode === 'create' ? 'NEW ACCOUNT' : modal.mode === 'edit' ? 'EDIT ACCOUNT' : 'RESET PASSWORD'}
                </p>
                <h2 className="modal__title">
                  {modal.mode === 'create'
                    ? '新建账号'
                    : modal.mode === 'edit'
                      ? modal.user.displayName
                      : `重置 ${modal.user.displayName} 的密码`}
                </h2>
                <p className="modal__sub">
                  {modal.mode === 'password'
                    ? '重置后旧密码立即失效，该账号的所有登录会话也会被吊销。'
                    : '角色决定能看到什么、能提交什么，服务端会再次校验。'}
                </p>

                {modal.mode === 'create' ? (
                  <>
                    <label className="field">
                      <span className="field__label">用户名</span>
                      <input
                        className="input"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        maxLength={30}
                        placeholder="字母、数字、下划线"
                        data-autofocus
                        required
                      />
                    </label>
                    <label className="field">
                      <span className="field__label">显示名称</span>
                      <input
                        className="input"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        maxLength={50}
                        required
                      />
                    </label>
                  </>
                ) : null}

                {modal.mode === 'edit' ? (
                  <label className="field">
                    <span className="field__label">显示名称</span>
                    <input
                      className="input"
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      maxLength={50}
                      required
                    />
                  </label>
                ) : null}

                {modal.mode !== 'password' ? (
                  <>
                    <label className="field">
                      <span className="field__label">角色</span>
                      <select
                        className="input"
                        value={role}
                        onChange={(event) => setRole(event.target.value as Role)}
                      >
                        {ROLES.map((value) => (
                          <option key={value} value={value}>
                            {ROLE_LABEL[value]}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="field">
                      <span className="field__label">部门</span>
                      <select
                        className="input"
                        value={departmentId}
                        onChange={(event) => setDepartmentId(event.target.value)}
                      >
                        <option value="">不归属部门</option>
                        {departments.map((department) => (
                          <option key={department.id} value={department.id}>
                            {department.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}

                {modal.mode === 'create' || modal.mode === 'password' ? (
                  <label className="field">
                    <span className="field__label">密码</span>
                    <input
                      className="input"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      minLength={8}
                      maxLength={200}
                      placeholder="至少 8 位"
                      autoComplete="new-password"
                      required
                    />
                  </label>
                ) : null}

                {modal.mode === 'edit' ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={(event) => setActive(event.target.checked)}
                      disabled={modal.user.id === currentUser?.id}
                    />
                    <span>账号启用（取消勾选会立即使其会话失效）</span>
                  </label>
                ) : null}

                {formError ? (
                  <p className="field__error" role="alert">
                    {formError}
                  </p>
                ) : null}

                <div className="modal__actions">
                  <Button type="submit" loading={busy}>
                    {modal.mode === 'create' ? '创建' : modal.mode === 'edit' ? '保存' : '重置密码'}
                  </Button>
                  <button type="button" className="text-btn" onClick={() => setModal(null)}>
                    取消
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}