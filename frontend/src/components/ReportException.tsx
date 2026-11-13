import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiPost } from '../api/client';
import { useModalFocus } from '../hooks/useModalFocus';
import { AlertIcon } from './Icons';
import { announce } from './LiveAnnouncer';
import { Button } from './ui';

/** 平板端也能用：任何已登录角色都可以对当前订单上报现场异常。 */
export function ReportException({ orderId }: { orderId: string }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const cardRef = useModalFocus(open, () => setOpen(false), { canClose: () => !busy });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (description.trim().length < 4) {
      setError('请至少描述 4 个字，方便管理员判断');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiPost('/exceptions', { orderId, description: description.trim() });
      setDescription('');
      setDone(true);
      setOpen(false);
      announce('异常已上报');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '上报失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="exception-trigger"
        onClick={() => {
          setDone(false);
          setOpen(true);
        }}
      >
        <AlertIcon size={15} />
        上报异常
      </button>

      {done ? <p className="role-note">异常已上报，管理员会在异常列表看到。</p> : null}

      {open
        ? createPortal(
            // portal 到 body：页面入场动画的 transform 会让 fixed 弹窗偏位
            <div className="modal" role="dialog" aria-modal="true" aria-label="上报异常">
          <button
            type="button"
            className="modal__backdrop"
            aria-label="关闭"
            onClick={() => setOpen(false)}
          />
          <form ref={cardRef} className="modal__card" onSubmit={(event) => void submit(event)}>
            <p className="eyebrow">INCIDENT REPORT</p>
            <h2 className="modal__title">上报异常</h2>
            <p className="modal__sub">描述越具体，管理员处理越快。上报会记录你的身份与时间。</p>

            <label className="field">
              <span className="field__label">异常描述</span>
              <textarea
                className="input input--textarea"
                rows={5}
                maxLength={500}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="例如：3 号机台配件尺寸偏差，无法装配，已暂停该批次"
                data-autofocus
              />
            </label>

            {error ? (
              <p className="field__error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="modal__actions">
              <Button type="submit" loading={busy}>
                提交上报
              </Button>
              <button type="button" className="text-btn" onClick={() => setOpen(false)}>
                取消
              </button>
            </div>
          </form>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}