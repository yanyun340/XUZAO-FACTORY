import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, apiGetPage } from '../api/client';
import type { TaskItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ArrowRight, RefreshIcon } from '../components/Icons';
import {
  ActionTag,
  EmptyState,
  InlineNotice,
  LoadingBlock,
  SectionHeading,
  StageRibbon,
  StatusBadge,
} from '../components/ui';
import {
  ACTION_HINT,
  ROLE_LABEL,
  dueHint,
  formatDateOnly,
  formatNumber,
  greeting,
} from '../lib/format';

/** 待办只显示当前角色此刻能推进的订单，按交期从早到晚排列。 */
export function TasksPage() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGetPage<TaskItem[]>('/tasks')
      .then((result) => {
        if (!cancelled) setTasks(result.data);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : '待办加载失败，请稍后重试');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const taskHref = (task: TaskItem) =>
    `/orders/${task.id}?action=${task.action}&from=tasks`;
  const nextTask = tasks[0];
  const nextHint = nextTask ? dueHint(nextTask.dueDate) : null;

  return (
    <div className="page page--tasks">
      <SectionHeading
        eyebrow={`${greeting()}，${user?.displayName ?? ''} · ${
          user ? ROLE_LABEL[user.role] : ''
        }${user?.department ? ` · ${user.department.name}` : ''}`}
        title="待办"
        description="只列出你所在岗位此刻能推进的订单，按交期从早到晚排列。点开即可直接处理。"
        action={
          <button
            type="button"
            className="icon-btn"
            onClick={() => setReloadToken((token) => token + 1)}
            title="刷新"
            aria-label="刷新待办"
          >
            <RefreshIcon size={17} />
          </button>
        }
      />

      {error ? (
        <InlineNotice tone="error">
          <span>{error}</span>
          <button
            type="button"
            className="notice__retry"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            重试
          </button>
        </InlineNotice>
      ) : null}

      <section className="task-desk" aria-live="polite" aria-busy={loading}>
        <div className="task-desk__head">
          <h2 className="panel__title">待处理</h2>
          <span className="task-desk__count mono">
            {loading ? '读取中' : `${formatNumber(tasks.length)} 单`}
          </span>
        </div>

        {loading ? (
          <LoadingBlock lines={4} />
        ) : tasks.length === 0 ? (
          <EmptyState
            title="此刻没有待办"
            description="新的流转到达后会按交期排到这里。也可以去订单总览查看全部进度。"
            action={
              <Link className="btn btn--secondary" to="/orders">
                <span className="btn__label">去订单总览</span>
              </Link>
            }
          />
        ) : (
          <div className="task-grid">
            {tasks.map((task) => {
              const hint = dueHint(task.dueDate);
              return (
                <Link
                  key={task.id}
                  to={taskHref(task)}
                  className="task-card"
                  aria-label={`处理订单 ${task.orderNo}：${ACTION_HINT[task.action]}`}
                >
                  <span className="task-card__top">
                    <span className="task-card__no mono">{task.orderNo}</span>
                    <StatusBadge status={task.status} dueDate={task.dueDate} />
                  </span>

                  <span className="task-card__customer">{task.customerName}</span>

                  <span className="task-card__product">
                    <span>{task.productSummary}</span>
                    <small>
                      {task.itemCount > 1 ? `${task.itemCount} 项 · ` : ''}
                      {formatNumber(task.totalQuantity)} 件
                    </small>
                  </span>

                  <StageRibbon stages={task.stages} />

                  <span className="task-card__foot">
                    <span className="task-card__action">
                      <ActionTag action={task.action} taskQty={task.taskQty} />
                      <small>{ACTION_HINT[task.action]}</small>
                    </span>
                    <span className="task-card__side">
                      <span className={`task-card__due due--${hint.tone}`}>
                        交期 {formatDateOnly(task.dueDate)} · {hint.text}
                      </span>
                      <span className="task-card__go" aria-hidden>
                        <ArrowRight size={16} />
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {!loading && nextTask && nextHint ? (
        <div className="task-bar" role="region" aria-label="待办快捷处理">
          <span className="task-bar__copy">
            <span className="task-bar__eyebrow mono">
              最近到期 · 共 {formatNumber(tasks.length)} 单
            </span>
            <strong className="task-bar__title">
              {nextTask.orderNo} · {ACTION_HINT[nextTask.action]}
            </strong>
            <small className={`task-bar__due due--${nextHint.tone}`}>
              {nextHint.text} · 本次 {formatNumber(nextTask.taskQty)} 件
            </small>
          </span>
          <Link className="task-bar__btn" to={taskHref(nextTask)}>
            去处理
            <ArrowRight size={16} />
          </Link>
        </div>
      ) : null}
    </div>
  );
}