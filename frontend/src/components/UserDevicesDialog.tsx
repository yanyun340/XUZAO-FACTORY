import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiDelete, apiGet, apiPatch } from '../api/client';
import type { DeviceItem, DeviceStatus, ManagedUser } from '../api/types';
import { useModalFocus } from '../hooks/useModalFocus';
import { formatDateTime } from '../lib/format';
import { Button, InlineNotice } from './ui';

const STATUS_LABEL: Record<DeviceStatus, string> = {
  PENDING: '待批准',
  ACTIVE: '已授权',
  REVOKED: '已吊销',
};

/**
 * R01F：受控设备管理。
 * 设备 ID 是浏览器生成的弱凭据：能挡住“换台设备直接输密码”，
 * 但清缓存或手工复制都能绕过，所以这里做的是审批与审计，不是硬件级绑定。
 */
export function UserDevicesDialog({
  user,
  onClose,
  onChanged,
}: {
  user: ManagedUser;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [binding, setBinding] = useState(user.deviceBindingMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const cardRef = useModalFocus(true, onClose, { canClose: () => !busy });

  const load = useCallback(async () => {
    try {
      setDevices(await apiGet<DeviceItem[]>(`/users/${user.id}/devices`));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '设备列表加载失败');
    }
  }, [user.id]);

  // 弹窗开着时轮询：管理员停在这一页，新提交的登录申请也会自动出现
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '操作失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const toggleBinding = () =>
    act(async () => {
      const next = binding === 'ENFORCED' ? 'OFF' : 'ENFORCED';
      const result = await apiPatch<{ deviceBindingMode: 'OFF' | 'ENFORCED' }>(
        `/users/${user.id}`,
        { deviceBindingMode: next },
      );
      setBinding(result.deviceBindingMode);
    }, binding === 'ENFORCED' ? '已关闭受控设备，该账号可在任意设备登录' : '已开启受控设备');

  const setStatus = (device: DeviceItem, status: 'ACTIVE' | 'REVOKED') =>
    act(
      () => apiPatch(`/users/${user.id}/devices/${device.id}`, { status }),
      status === 'ACTIVE' ? `已批准设备 ${device.deviceCode}` : `已吊销设备 ${device.deviceCode}`,
    );

  const remove = (device: DeviceItem) => {
    if (!window.confirm(`删除设备 ${device.deviceCode}？该设备上的登录会立即失效。`)) return;
    void act(
      () => apiDelete(`/users/${user.id}/devices/${device.id}`),
      `已删除设备 ${device.deviceCode}`,
    );
  };

  const activeCount = devices.filter((device) => device.status === 'ACTIVE').length;

  return createPortal(
    <div className="modal" role="dialog" aria-modal="true" aria-label="受控设备">
      <button type="button" className="modal__backdrop" aria-label="关闭" onClick={onClose} />
      <form
        ref={cardRef}
        className="modal__card modal__card--wide"
        onSubmit={(event) => event.preventDefault()}
      >
        <p className="eyebrow">CONTROLLED DEVICE</p>
        <h2 className="modal__title">受控设备 · {user.displayName}</h2>
        <p className="modal__sub">
          开启后，该账号只能从已授权设备登录；新设备需要管理员批准。设备标识存在浏览器里，属于弱绑定。
        </p>

        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        {notice ? <InlineNotice tone="info">{notice}</InlineNotice> : null}

        <div className="device-binding">
          <div>
            <strong>{binding === 'ENFORCED' ? '已开启受控设备' : '未开启受控设备'}</strong>
            <p className="next-step__hint">
              {binding === 'ENFORCED'
                ? `当前 ${activeCount} 台已授权设备在生效。`
                : '任何设备只要密码正确就能登录。'}
            </p>
          </div>
          <Button
            type="button"
            variant={binding === 'ENFORCED' ? 'secondary' : 'primary'}
            loading={busy}
            onClick={() => void toggleBinding()}
          >
            {binding === 'ENFORCED' ? '关闭受控设备' : '开启受控设备'}
          </Button>
        </div>
        {binding === 'OFF' ? (
          <p className="next-step__hint">
            开启后，该账号下一台登录的设备会进入“待批准”，批准后才能拿到会话。
          </p>
        ) : null}

        {devices.length === 0 ? (
          <p className="detail-card__empty">
            还没有设备记录。让该账号在新设备上登录一次，系统会生成待批准设备。
          </p>
        ) : (
          <ul className="attach-list">
            {devices.map((device) => (
              <li key={device.id} className="attach-item">
                <span className="attach-item__name">
                  <span className="attach-item__title">
                    {device.label}
                    <span className={`badge badge--device-${device.status.toLowerCase()}`}>
                      {STATUS_LABEL[device.status]}
                    </span>
                  </span>
                  <span className="attach-item__meta mono">
                    设备码 {device.deviceCode} · 最近登录{' '}
                    {device.lastSeenAt ? formatDateTime(device.lastSeenAt) : '从未'}
                  </span>
                </span>
                <span className="exception-dispose__actions">
                  {device.status === 'PENDING' ? (
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={() => void setStatus(device, 'ACTIVE')}
                    >
                      批准
                    </button>
                  ) : null}
                  {device.status === 'ACTIVE' ? (
                    <button
                      type="button"
                      className="text-btn"
                      disabled={busy}
                      onClick={() => void setStatus(device, 'REVOKED')}
                    >
                      吊销
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-btn"
                    disabled={busy}
                    onClick={() => remove(device)}
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="modal__actions">
          <button type="button" className="text-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}