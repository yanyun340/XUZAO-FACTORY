import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiGet, apiPost } from '../api/client';
import type { CreateOrderInput, Customer, OrderDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ArrowLeft, ArrowUpRight, CloseIcon, PlusIcon } from '../components/Icons';
import { Button, Field, InlineNotice, SectionHeading } from '../components/ui';
import { formatMoney, todayDateInput } from '../lib/format';

const DRAFT_KEY = 'xuzao.orderDraft.v1';
const MAX_ITEMS = 10;

interface DraftItem {
  key: string;
  productName: string;
  spec: string;
  quantity: string;
  unitPrice: string;
}

interface Draft {
  customerId: string;
  dueDate: string;
  remark: string;
  items: DraftItem[];
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function emptyItem(): DraftItem {
  return {
    key: crypto.randomUUID(),
    productName: '',
    spec: '',
    quantity: '',
    unitPrice: '',
  };
}

function initialDraft(): Draft {
  return {
    customerId: '',
    dueDate: addDays(todayDateInput(), 14),
    remark: '',
    items: [emptyItem()],
  };
}

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    if (typeof parsed.dueDate !== 'string' || typeof parsed.customerId !== 'string') return null;

    const items = parsed.items
      .filter((item): item is DraftItem => typeof item?.key === 'string')
      .map((item) => ({
        key: item.key,
        productName: String(item.productName ?? ''),
        spec: String(item.spec ?? ''),
        quantity: String(item.quantity ?? ''),
        unitPrice: String(item.unitPrice ?? ''),
      }));

    if (items.length === 0) return null;
    return {
      customerId: parsed.customerId,
      dueDate: parsed.dueDate,
      remark: String(parsed.remark ?? ''),
      items,
    };
  } catch {
    return null;
  }
}

export function NewOrderPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const initial = useMemo(loadDraft, []);
  const [draft, setDraft] = useState<Draft>(() => initial ?? initialDraft());
  const [restored, setRestored] = useState(initial !== null);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [customersLoading, setCustomersLoading] = useState(true);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attemptRef = useRef<{ hash: string; key: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiGet<Customer[]>('/customers?active=true&pageSize=200')
      .then((result) => {
        if (!cancelled) setCustomers(result);
      })
      .catch((caught) => {
        if (!cancelled) {
          setCustomersError(caught instanceof ApiError ? caught.message : '客户列表加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setCustomersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const selectedCustomer = customers.find((customer) => customer.id === draft.customerId) ?? null;

  const total = useMemo(() => {
    const cents = draft.items.reduce((sum, item) => {
      const quantity = Number(item.quantity);
      const price = Number(item.unitPrice);
      if (!Number.isInteger(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
        return sum;
      }
      return sum + Math.round(price * 100) * quantity;
    }, 0);
    return (cents / 100).toFixed(2);
  }, [draft.items]);

  const totalQuantity = draft.items.reduce((sum, item) => {
    const quantity = Number(item.quantity);
    return sum + (Number.isInteger(quantity) && quantity > 0 ? quantity : 0);
  }, 0);

  if (user && user.role !== 'ADMIN') {
    return (
      <div className="page">
        <SectionHeading eyebrow="权限受限" title="新建订单" />
        <div className="panel panel--pad">
          <InlineNotice tone="info">
            当前角色（{user.displayName}）只能查看订单，不能创建业务订单。请让管理员操作。
          </InlineNotice>
          <Link className="text-link" to="/orders">
            返回订单总览
          </Link>
        </div>
      </div>
    );
  }

  const updateDraft = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
    setSubmitError(null);
  };

  const updateItem = (key: string, patch: Partial<DraftItem>) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    }));
    setErrors({});
    setSubmitError(null);
  };

  const removeItem = (key: string) => {
    setDraft((current) => ({
      ...current,
      items: current.items.length > 1 ? current.items.filter((item) => item.key !== key) : current.items,
    }));
  };

  const addItem = () => {
    setDraft((current) =>
      current.items.length >= MAX_ITEMS
        ? current
        : { ...current, items: [...current.items, emptyItem()] },
    );
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!draft.customerId) next.customerId = '请选择客户';
    if (!draft.dueDate) {
      next.dueDate = '请选择交期';
    } else if (draft.dueDate < todayDateInput()) {
      next.dueDate = '交期不能早于今天';
    }

    draft.items.forEach((item, index) => {
      const prefix = `items.${item.key}`;
      if (!item.productName.trim()) next[`${prefix}.productName`] = '填写产品名称';
      if (!item.spec.trim()) next[`${prefix}.spec`] = '填写规格';
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) {
        next[`${prefix}.quantity`] = '数量必须是正整数';
      }
      if (!/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(item.unitPrice)) {
        next[`${prefix}.unitPrice`] = '单价需为非负金额，最多两位小数';
      }
      if (index >= MAX_ITEMS) next.items = `最多添加 ${MAX_ITEMS} 项明细`;
    });

    return next;
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    const nextErrors = validate();
    setErrors(nextErrors);
    setSubmitError(null);
    if (Object.keys(nextErrors).length > 0) return;

    const payload: CreateOrderInput = {
      customerId: draft.customerId,
      dueDate: draft.dueDate,
      ...(draft.remark.trim() ? { remark: draft.remark.trim() } : {}),
      items: draft.items.map((item) => ({
        productName: item.productName.trim(),
        spec: item.spec.trim(),
        quantity: Number(item.quantity),
        unitPrice: item.unitPrice,
      })),
    };

    // 相同内容重试复用同一个幂等键；内容一改就换新键，避免“旧结果”被错误复用。
    const hash = JSON.stringify(payload);
    const key =
      attemptRef.current?.hash === hash
        ? attemptRef.current.key
        : `order-${crypto.randomUUID()}`;
    attemptRef.current = { hash, key };

    setSubmitting(true);
    try {
      const created = await apiPost<OrderDetail>('/orders', payload, {
        'Idempotency-Key': key,
      });
      localStorage.removeItem(DRAFT_KEY);
      navigate(`/orders/${created.id}`, { replace: true, state: { justCreated: true } });
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'NETWORK_ERROR') {
          setSubmitError(
            '网络中断，订单可能已经创建成功。请保持表单不变再次提交，系统会用同一幂等键重试，不会重复建单。',
          );
        } else if (caught.code === 'REQUEST_IN_PROGRESS') {
          setSubmitError('上一次提交仍在处理中，请稍等几秒后再重试。');
        } else {
          setSubmitError(caught.message);
        }
      } else {
        setSubmitError('提交失败，请稍后重试');
      }
      setSubmitting(false);
    }
  };

  const clearDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
    setDraft(initialDraft());
    setRestored(false);
    setErrors({});
    setSubmitError(null);
    attemptRef.current = null;
  };

  return (
    <div className="page">
      <Link className="back-link" to="/orders">
        <ArrowLeft size={16} />
        返回订单总览
      </Link>

      <SectionHeading
        eyebrow="ORDERS / NEW"
        title="新建业务订单"
        description="订单号由后端并发安全生成。提交后进入待采购状态，后续动作都在同一张订单下留痕。"
      />

      {restored ? (
        <InlineNotice tone="info">
          <span>已恢复上次未提交的草稿。你可以继续编辑，或清空后重新填写。</span>
          <button type="button" className="notice__retry" onClick={clearDraft}>
            清空草稿
          </button>
        </InlineNotice>
      ) : null}

      {customersError ? (
        <InlineNotice tone="error">
          客户列表加载失败：{customersError}
          <Link className="notice__retry" to="/base-data">
            去基础数据
          </Link>
        </InlineNotice>
      ) : null}

      <form className="form-layout" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="form-layout__main">
          <section className="bezelt">
            <div className="form-card">
              <div className="form-card__head">
                <span className="form-card__step mono">01</span>
                <div>
                  <h2>订单信息</h2>
                  <p>客户与交期决定这张订单的对外承诺。</p>
                </div>
              </div>

              <div className="form-grid">
                <Field
                  label="客户"
                  htmlFor="customerId"
                  required
                  error={errors.customerId}
                  hint={
                    customersLoading
                      ? '正在加载客户…'
                      : selectedCustomer
                        ? `${selectedCustomer.code}${selectedCustomer.contact ? ` · 联系人 ${selectedCustomer.contact}` : ''}`
                        : '客户来自基础数据，停用的客户不会出现在这里。'
                  }
                >
                  <select
                    id="customerId"
                    className="input input--select"
                    value={draft.customerId}
                    onChange={(event) => updateDraft({ customerId: event.target.value })}
                    disabled={customersLoading}
                  >
                    <option value="">选择客户</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.code} · {customer.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="交期" htmlFor="dueDate" required error={errors.dueDate} hint="按北京时间自然日计算">
                  <input
                    id="dueDate"
                    className="input"
                    type="date"
                    min={todayDateInput()}
                    value={draft.dueDate}
                    onChange={(event) => updateDraft({ dueDate: event.target.value })}
                  />
                </Field>
              </div>

              <Field label="备注" htmlFor="remark" hint="选填，最多 500 字">
                <textarea
                  id="remark"
                  className="input input--textarea"
                  rows={3}
                  maxLength={500}
                  value={draft.remark}
                  onChange={(event) => updateDraft({ remark: event.target.value })}
                  placeholder="例如：客户要求分两批交付，首批 60 件"
                />
              </Field>
            </div>
          </section>

          <section className="bezelt">
            <div className="form-card">
              <div className="form-card__head">
                <span className="form-card__step mono">02</span>
                <div>
                  <h2>产品明细</h2>
                  <p>数量与单价会进入后续利润口径，提交后不可直接编辑。</p>
                </div>
              </div>

              <div className="items">
                {draft.items.map((item, index) => (
                  <div className="item-row" key={item.key}>
                    <div className="item-row__head">
                      <span className="item-row__index mono">明细 {String(index + 1).padStart(2, '0')}</span>
                      {draft.items.length > 1 ? (
                        <button
                          type="button"
                          className="item-row__remove"
                          onClick={() => removeItem(item.key)}
                          aria-label={`删除明细 ${index + 1}`}
                        >
                          <CloseIcon size={15} />
                        </button>
                      ) : null}
                    </div>

                    <div className="form-grid form-grid--item">
                      <Field
                        label="产品名称"
                        htmlFor={`product-${item.key}`}
                        required
                        error={errors[`items.${item.key}.productName`]}
                      >
                        <input
                          id={`product-${item.key}`}
                          className="input"
                          value={item.productName}
                          onChange={(event) => updateItem(item.key, { productName: event.target.value })}
                          placeholder="例如：不锈钢法兰组件"
                        />
                      </Field>

                      <Field
                        label="规格"
                        htmlFor={`spec-${item.key}`}
                        required
                        error={errors[`items.${item.key}.spec`]}
                      >
                        <input
                          id={`spec-${item.key}`}
                          className="input"
                          value={item.spec}
                          onChange={(event) => updateItem(item.key, { spec: event.target.value })}
                          placeholder="例如：DN50 / 8mm"
                        />
                      </Field>

                      <Field
                        label="数量"
                        htmlFor={`qty-${item.key}`}
                        required
                        error={errors[`items.${item.key}.quantity`]}
                      >
                        <input
                          id={`qty-${item.key}`}
                          className="input mono"
                          inputMode="numeric"
                          value={item.quantity}
                          onChange={(event) => updateItem(item.key, { quantity: event.target.value })}
                          placeholder="100"
                        />
                      </Field>

                      <Field
                        label="单价（元）"
                        htmlFor={`price-${item.key}`}
                        required
                        error={errors[`items.${item.key}.unitPrice`]}
                        hint="不含税，最多两位小数"
                      >
                        <input
                          id={`price-${item.key}`}
                          className="input mono"
                          inputMode="decimal"
                          value={item.unitPrice}
                          onChange={(event) => updateItem(item.key, { unitPrice: event.target.value })}
                          placeholder="12.50"
                        />
                      </Field>
                    </div>
                  </div>
                ))}
              </div>

              {errors.items ? <p className="field__error">{errors.items}</p> : null}

              <button
                type="button"
                className="dashed-btn"
                onClick={addItem}
                disabled={draft.items.length >= MAX_ITEMS}
              >
                <PlusIcon size={16} />
                添加产品明细
                <span className="dashed-btn__limit mono">
                  {draft.items.length}/{MAX_ITEMS}
                </span>
              </button>
            </div>
          </section>
        </div>

        <aside className="form-layout__aside">
          <div className="bezelt">
            <div className="summary">
              <p className="eyebrow">ORDER SUMMARY</p>
              <h2 className="summary__title">提交摘要</h2>

              <dl className="summary__list">
                <div>
                  <dt>客户</dt>
                  <dd>{selectedCustomer?.name ?? '未选择'}</dd>
                </div>
                <div>
                  <dt>交期</dt>
                  <dd className="mono">{draft.dueDate || '未选择'}</dd>
                </div>
                <div>
                  <dt>明细</dt>
                  <dd>{draft.items.length} 项 · {totalQuantity} 件</dd>
                </div>
              </dl>

              <div className="summary__total">
                <span>订单金额</span>
                <strong className="mono">{formatMoney(total)}</strong>
              </div>
              <p className="summary__note">金额为订单快照，不代表已收款或已结算。</p>

              {submitError ? <InlineNotice tone="error">{submitError}</InlineNotice> : null}

              <Button
                type="submit"
                loading={submitting}
                className="btn--block"
                trailing={<ArrowUpRight size={16} />}
              >
                {submitting ? '正在提交' : '提交订单'}
              </Button>

              <p className="summary__fineprint">
                提交后状态进入「待采购」。重复点击或网络重试不会重复建单。
              </p>
            </div>
          </div>
        </aside>
      </form>
    </div>
  );
}