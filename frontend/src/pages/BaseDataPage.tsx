import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, apiGetPage, apiPatch, apiPost } from '../api/client';
import type { Customer, Department, PageMeta } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PlusIcon } from '../components/Icons';
import {
  Button,
  EmptyState,
  Field,
  InlineNotice,
  LoadingBlock,
  SectionHeading,
} from '../components/ui';
import { formatDateOnly } from '../lib/format';

type TabKey = 'customers' | 'suppliers' | 'parts' | 'departments' | 'employees';

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'customers', label: '客户', hint: '业务订单的甲方' },
  { key: 'suppliers', label: '供应商', hint: '采购与电镀来源' },
  { key: 'parts', label: '配件', hint: '采购物料主数据' },
  { key: 'departments', label: '部门', hint: '生产 / 物流 / 品控 / 包装' },
  { key: 'employees', label: '员工', hint: '生产任务可指派对象' },
];

interface Supplier {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  active: boolean;
  createdAt: string;
}

interface Part {
  id: string;
  code: string;
  name: string;
  spec: string;
  active: boolean;
  createdAt: string;
}

interface Employee {
  id: string;
  code: string;
  name: string;
  departmentId: string;
  department: { id: string; code: string; name: string; category: string };
  active: boolean;
  createdAt: string;
}

interface Collection<T> {
  items: T[];
  meta: PageMeta | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useCollection<T>(path: string): Collection<T> {
  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    apiGetPage<T[]>(path)
      .then((result) => {
        if (cancelled) return;
        setItems(result.data);
        setMeta(result.meta);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : '加载失败，请稍后重试');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, token]);

  return { items, meta, loading, error, reload: () => setToken((value) => value + 1) };
}

function DataTable<T extends { id: string }>({
  columns,
  items,
  loading,
  error,
  emptyTitle,
  onRetry,
}: {
  columns: Array<{ key: string; label: string; render: (item: T) => ReactNode }>;
  items: T[];
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  onRetry: () => void;
}) {
  if (loading) return <LoadingBlock lines={5} />;

  if (error) {
    return (
      <InlineNotice tone="error">
        {error}
        <button type="button" className="notice__retry" onClick={onRetry}>
          重试
        </button>
      </InlineNotice>
    );
  }

  if (items.length === 0) {
    return <EmptyState title={emptyTitle} description="使用右侧表单添加第一条记录。" />;
  }

  return (
    <div className="data-table">
      <div className="data-table__head" aria-hidden>
        {columns.map((column) => (
          <span key={column.key}>{column.label}</span>
        ))}
      </div>
      {items.map((item) => (
        <div className="data-table__row" key={item.id}>
          {columns.map((column) => (
            <span key={column.key}>{column.render(item)}</span>
          ))}
        </div>
      ))}
    </div>
  );
}

function Panel({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count: number | null;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2 className="panel__title">{title}</h2>
          <p className="panel__meta">{hint}</p>
        </div>
        <span className="panel__count">{count === null ? '' : `${count} 条`}</span>
      </div>
      {children}
    </section>
  );
}

function useCreate(endpoint: string, onDone: () => void) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const submit = async (body: unknown) => {
    setSubmitting(true);
    setError(null);
    setSaved(false);
    try {
      await apiPost(endpoint, body);
      setSaved(true);
      onDone();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败，请稍后重试');
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  return { submitting, error, saved, submit };
}

function useUpdate(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await apiPatch(path, body);
      onDone();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '保存失败，请稍后重试');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, save, clearError: () => setError(null) };
}

type EditValues = Record<string, string | boolean>;

interface EditFieldDef {
  key: string;
  label: string;
  kind: 'text' | 'select' | 'check';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  placeholder?: string;
}

/** 基础数据共用的编辑弹窗：字段由调用方描述，保存交给对应的 PATCH。 */
function EditDialog({
  eyebrow,
  title,
  sub,
  fields,
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  fields: EditFieldDef[];
  initial: EditValues;
  busy: boolean;
  error: string | null;
  onSubmit: (values: EditValues) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<EditValues>(initial);

  const set = (key: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }));

  // 弹窗打开时锁住背后页面滚动，Esc 关闭；不用键盘提交，避免误触。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [busy, onClose]);

  return createPortal(
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="modal__backdrop" aria-label="关闭" onClick={onClose} />
      <form
        className="modal__card"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(values);
        }}
      >
        <p className="eyebrow">{eyebrow}</p>
        <h2 className="modal__title">{title}</h2>
        <p className="modal__sub">{sub}</p>

        {fields.map((field) =>
          field.kind === 'check' ? (
            <label className="check-field" key={field.key}>
              <input
                type="checkbox"
                checked={Boolean(values[field.key])}
                onChange={(event) => set(field.key, event.target.checked)}
              />
              <span>{field.label}</span>
            </label>
          ) : field.kind === 'select' ? (
            <label className="field" key={field.key}>
              <span className="field__label">{field.label}</span>
              <select
                className="input"
                value={String(values[field.key] ?? '')}
                onChange={(event) => set(field.key, event.target.value)}
                required={field.required}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="field" key={field.key}>
              <span className="field__label">{field.label}</span>
              <input
                className="input"
                value={String(values[field.key] ?? '')}
                onChange={(event) => set(field.key, event.target.value)}
                required={field.required}
                placeholder={field.placeholder}
                autoFocus={field.key === fields[0]?.key}
              />
            </label>
          ),
        )}

        {error ? (
          <p className="field__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="modal__actions">
          <Button type="submit" loading={busy}>
            保存
          </Button>
          <button type="button" className="text-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function StatusCell({ active }: { active: boolean }) {
  return (
    <span className={`user-row__state ${active ? 'is-on' : 'is-off'}`}>
      {active ? '启用' : '停用'}
    </span>
  );
}

function RowActions({
  active,
  onEdit,
  onToggle,
  busy,
}: {
  active: boolean;
  onEdit: () => void;
  onToggle: () => void;
  busy: boolean;
}) {
  return (
    <span className="data-table__actions">
      <button type="button" className="text-btn" onClick={onEdit}>
        编辑
      </button>
      <button type="button" className="text-btn" onClick={onToggle} disabled={busy}>
        {active ? '停用' : '启用'}
      </button>
    </span>
  );
}

function CustomerPanel({ canEdit }: { canEdit: boolean }) {
  const collection = useCollection<Customer>('/customers?pageSize=200');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const create = useCreate('/customers', () => {
    setName('');
    setContact('');
    setPhone('');
    collection.reload();
  });
  const [editing, setEditing] = useState<Customer | null>(null);
  const update = useUpdate(() => {
    setEditing(null);
    collection.reload();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const done = await create.submit({
      name: name.trim(),
      ...(contact.trim() ? { contact: contact.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
    if (done) setName('');
  };

  const toggle = (item: Customer) =>
    void update.save(`/customers/${item.id}`, { active: !item.active });

  return (
    <div className={`data-layout${canEdit ? '' : ' data-layout--single'}`}>
      <Panel title="客户" hint="订单快照来源；停用不影响历史订单" count={collection.meta?.total ?? null}>
        <DataTable
          items={collection.items}
          loading={collection.loading}
          error={collection.error}
          emptyTitle="还没有客户"
          onRetry={collection.reload}
          columns={[
            { key: 'code', label: '编码', render: (item) => <span className="mono">{item.code}</span> },
            { key: 'name', label: '名称', render: (item) => <strong>{item.name}</strong> },
            { key: 'contact', label: '联系人', render: (item) => item.contact ?? '—' },
            { key: 'phone', label: '电话', render: (item) => <span className="mono">{item.phone ?? '—'}</span> },
            {
              key: 'created',
              label: '创建',
              render: (item) => <span className="muted">{formatDateOnly(item.createdAt.slice(0, 10))}</span>,
            },
            { key: 'active', label: '状态', render: (item) => <StatusCell active={item.active} /> },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    label: '',
                    render: (item: Customer) => (
                      <RowActions
                        active={item.active}
                        onEdit={() => setEditing(item)}
                        onToggle={() => toggle(item)}
                        busy={update.busy}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {canEdit ? (
        <Panel title="新增客户" hint="编码留空时由系统生成" count={null}>
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <Field label="客户名称" htmlFor="customer-name" required>
              <input
                id="customer-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：宁波精密机械有限公司"
              />
            </Field>
            <Field label="联系人" htmlFor="customer-contact">
              <input
                id="customer-contact"
                className="input"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="选填"
              />
            </Field>
            <Field label="电话" htmlFor="customer-phone">
              <input
                id="customer-phone"
                className="input"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="选填"
              />
            </Field>
            {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
            {create.saved ? <InlineNotice tone="info">客户已添加。</InlineNotice> : null}
            <Button type="submit" loading={create.submitting} trailing={<PlusIcon size={16} />}>
              添加客户
            </Button>
          </form>
        </Panel>
      ) : null}

      {editing ? (
        <EditDialog
          key={editing.id}
          eyebrow="EDIT CUSTOMER"
          title={editing.name}
          sub="改名只影响之后的引用；历史订单保留创建时的客户名称快照。"
          initial={{
            name: editing.name,
            contact: editing.contact ?? '',
            phone: editing.phone ?? '',
            active: editing.active,
          }}
          fields={[
            { key: 'name', label: '客户名称', kind: 'text', required: true },
            { key: 'contact', label: '联系人', kind: 'text', placeholder: '选填' },
            { key: 'phone', label: '电话', kind: 'text', placeholder: '选填' },
            { key: 'active', label: '启用（停用后不能用于新建订单）', kind: 'check' },
          ]}
          busy={update.busy}
          error={update.error}
          onClose={() => {
            setEditing(null);
            update.clearError();
          }}
          onSubmit={(values) =>
            void update.save(`/customers/${editing.id}`, {
              name: String(values.name ?? '').trim(),
              contact: String(values.contact ?? '').trim() || null,
              phone: String(values.phone ?? '').trim() || null,
              active: Boolean(values.active),
            })
          }
        />
      ) : null}
    </div>
  );
}

function SupplierPanel({ canEdit }: { canEdit: boolean }) {
  const collection = useCollection<Supplier>('/suppliers?pageSize=200');
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const create = useCreate('/suppliers', () => {
    setName('');
    setContact('');
    setPhone('');
    collection.reload();
  });
  const [editing, setEditing] = useState<Supplier | null>(null);
  const update = useUpdate(() => {
    setEditing(null);
    collection.reload();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    await create.submit({
      name: name.trim(),
      ...(contact.trim() ? { contact: contact.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
  };

  const toggle = (item: Supplier) =>
    void update.save(`/suppliers/${item.id}`, { active: !item.active });

  return (
    <div className={`data-layout${canEdit ? '' : ' data-layout--single'}`}>
      <Panel title="供应商" hint="采购单与电镀服务的来源" count={collection.meta?.total ?? null}>
        <DataTable
          items={collection.items}
          loading={collection.loading}
          error={collection.error}
          emptyTitle="还没有供应商"
          onRetry={collection.reload}
          columns={[
            { key: 'code', label: '编码', render: (item) => <span className="mono">{item.code}</span> },
            { key: 'name', label: '名称', render: (item) => <strong>{item.name}</strong> },
            { key: 'contact', label: '联系人', render: (item) => item.contact ?? '—' },
            { key: 'phone', label: '电话', render: (item) => <span className="mono">{item.phone ?? '—'}</span> },
            { key: 'active', label: '状态', render: (item) => <StatusCell active={item.active} /> },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    label: '',
                    render: (item: Supplier) => (
                      <RowActions
                        active={item.active}
                        onEdit={() => setEditing(item)}
                        onToggle={() => toggle(item)}
                        busy={update.busy}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {canEdit ? (
        <Panel title="新增供应商" hint="编码留空时由系统生成" count={null}>
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <Field label="供应商名称" htmlFor="supplier-name" required>
              <input
                id="supplier-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：无锡恒信金属材料有限公司"
              />
            </Field>
            <Field label="联系人" htmlFor="supplier-contact">
              <input
                id="supplier-contact"
                className="input"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="选填"
              />
            </Field>
            <Field label="电话" htmlFor="supplier-phone">
              <input
                id="supplier-phone"
                className="input"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="选填"
              />
            </Field>
            {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
            {create.saved ? <InlineNotice tone="info">供应商已添加。</InlineNotice> : null}
            <Button type="submit" loading={create.submitting} trailing={<PlusIcon size={16} />}>
              添加供应商
            </Button>
          </form>
        </Panel>
      ) : null}

      {editing ? (
        <EditDialog
          key={editing.id}
          eyebrow="EDIT SUPPLIER"
          title={editing.name}
          sub="改名不会改写已有采购单上的供应商名称；停用后不能再被选来建采购。"
          initial={{
            name: editing.name,
            contact: editing.contact ?? '',
            phone: editing.phone ?? '',
            active: editing.active,
          }}
          fields={[
            { key: 'name', label: '供应商名称', kind: 'text', required: true },
            { key: 'contact', label: '联系人', kind: 'text', placeholder: '选填' },
            { key: 'phone', label: '电话', kind: 'text', placeholder: '选填' },
            { key: 'active', label: '启用（停用后不能用于新建采购）', kind: 'check' },
          ]}
          busy={update.busy}
          error={update.error}
          onClose={() => {
            setEditing(null);
            update.clearError();
          }}
          onSubmit={(values) =>
            void update.save(`/suppliers/${editing.id}`, {
              name: String(values.name ?? '').trim(),
              contact: String(values.contact ?? '').trim() || null,
              phone: String(values.phone ?? '').trim() || null,
              active: Boolean(values.active),
            })
          }
        />
      ) : null}
    </div>
  );
}

function PartPanel({ canEdit }: { canEdit: boolean }) {
  const collection = useCollection<Part>('/parts?pageSize=200');
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const create = useCreate('/parts', () => {
    setName('');
    setSpec('');
    collection.reload();
  });
  const [editing, setEditing] = useState<Part | null>(null);
  const update = useUpdate(() => {
    setEditing(null);
    collection.reload();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !spec.trim()) return;
    await create.submit({ name: name.trim(), spec: spec.trim() });
  };

  const toggle = (item: Part) => void update.save(`/parts/${item.id}`, { active: !item.active });

  return (
    <div className={`data-layout${canEdit ? '' : ' data-layout--single'}`}>
      <Panel title="配件" hint="采购物料主数据，名称与规格为快照来源" count={collection.meta?.total ?? null}>
        <DataTable
          items={collection.items}
          loading={collection.loading}
          error={collection.error}
          emptyTitle="还没有配件"
          onRetry={collection.reload}
          columns={[
            { key: 'code', label: '编码', render: (item) => <span className="mono">{item.code}</span> },
            { key: 'name', label: '名称', render: (item) => <strong>{item.name}</strong> },
            { key: 'spec', label: '规格', render: (item) => item.spec },
            { key: 'active', label: '状态', render: (item) => <StatusCell active={item.active} /> },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    label: '',
                    render: (item: Part) => (
                      <RowActions
                        active={item.active}
                        onEdit={() => setEditing(item)}
                        onToggle={() => toggle(item)}
                        busy={update.busy}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {canEdit ? (
        <Panel title="新增配件" hint="编码留空时由系统生成" count={null}>
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <Field label="配件名称" htmlFor="part-name" required>
              <input
                id="part-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：304 不锈钢法兰"
              />
            </Field>
            <Field label="规格" htmlFor="part-spec" required>
              <input
                id="part-spec"
                className="input"
                value={spec}
                onChange={(event) => setSpec(event.target.value)}
                placeholder="例如：DN50 / 厚 8mm"
              />
            </Field>
            {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
            {create.saved ? <InlineNotice tone="info">配件已添加。</InlineNotice> : null}
            <Button type="submit" loading={create.submitting} trailing={<PlusIcon size={16} />}>
              添加配件
            </Button>
          </form>
        </Panel>
      ) : null}

      {editing ? (
        <EditDialog
          key={editing.id}
          eyebrow="EDIT PART"
          title={`${editing.code} · ${editing.name}`}
          sub="名称和规格只影响之后的引用；已有采购单保留下单时的快照。"
          initial={{ name: editing.name, spec: editing.spec, active: editing.active }}
          fields={[
            { key: 'name', label: '配件名称', kind: 'text', required: true },
            { key: 'spec', label: '规格', kind: 'text', required: true },
            { key: 'active', label: '启用（停用后不能用于新建采购）', kind: 'check' },
          ]}
          busy={update.busy}
          error={update.error}
          onClose={() => {
            setEditing(null);
            update.clearError();
          }}
          onSubmit={(values) =>
            void update.save(`/parts/${editing.id}`, {
              name: String(values.name ?? '').trim(),
              spec: String(values.spec ?? '').trim(),
              active: Boolean(values.active),
            })
          }
        />
      ) : null}
    </div>
  );
}

const DEPARTMENT_CATEGORIES = [
  { value: 'PRODUCTION', label: '生产' },
  { value: 'LOGISTICS', label: '物流' },
  { value: 'QC', label: '品控' },
  { value: 'PACKING', label: '包装' },
];

type DepartmentRow = Department & { _count: { employees: number } };

function DepartmentPanel({ canEdit }: { canEdit: boolean }) {
  const collection = useCollection<DepartmentRow>('/departments');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState('PRODUCTION');
  const create = useCreate('/departments', () => {
    setCode('');
    setName('');
    collection.reload();
  });
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const update = useUpdate(() => {
    setEditing(null);
    collection.reload();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || !name.trim()) return;
    await create.submit({ code: code.trim(), name: name.trim(), category });
  };

  const toggle = (item: DepartmentRow) =>
    void update.save(`/departments/${item.id}`, { active: item.active === false });

  return (
    <div className={`data-layout${canEdit ? '' : ' data-layout--single'}`}>
      <Panel title="部门" hint="部门类别决定现场人员能看到的任务范围" count={collection.meta?.total ?? null}>
        <DataTable
          items={collection.items}
          loading={collection.loading}
          error={collection.error}
          emptyTitle="还没有部门"
          onRetry={collection.reload}
          columns={[
            { key: 'code', label: '编码', render: (item) => <span className="mono">{item.code}</span> },
            { key: 'name', label: '名称', render: (item) => <strong>{item.name}</strong> },
            {
              key: 'category',
              label: '类别',
              render: (item) =>
                DEPARTMENT_CATEGORIES.find((entry) => entry.value === item.category)?.label ??
                item.category,
            },
            {
              key: 'employees',
              label: '员工数',
              render: (item) => <span className="mono">{item._count.employees}</span>,
            },
            { key: 'active', label: '状态', render: (item) => <StatusCell active={item.active !== false} /> },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    label: '',
                    render: (item: DepartmentRow) => (
                      <RowActions
                        active={item.active !== false}
                        onEdit={() => setEditing(item)}
                        onToggle={() => toggle(item)}
                        busy={update.busy}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {canEdit ? (
        <Panel title="新增部门" hint="编码用于稳定引用，创建后不建议修改" count={null}>
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <Field label="部门编码" htmlFor="dept-code" required hint="2-30 位字母、数字、_ 或 -">
              <input
                id="dept-code"
                className="input mono"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="例如：PROD"
              />
            </Field>
            <Field label="部门名称" htmlFor="dept-name" required>
              <input
                id="dept-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：生产部"
              />
            </Field>
            <Field label="类别" htmlFor="dept-category" required>
              <select
                id="dept-category"
                className="input input--select"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {DEPARTMENT_CATEGORIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </Field>
            {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
            {create.saved ? <InlineNotice tone="info">部门已添加。</InlineNotice> : null}
            <Button type="submit" loading={create.submitting} trailing={<PlusIcon size={16} />}>
              添加部门
            </Button>
          </form>
        </Panel>
      ) : null}

      {editing ? (
        <EditDialog
          key={editing.id}
          eyebrow="EDIT DEPARTMENT"
          title={`${editing.code} · ${editing.name}`}
          sub="已有生产任务的部门不能改类别；停用后不能再承接新的下发。"
          initial={{
            name: editing.name,
            category: editing.category,
            active: editing.active !== false,
          }}
          fields={[
            { key: 'name', label: '部门名称', kind: 'text', required: true },
            {
              key: 'category',
              label: '类别',
              kind: 'select',
              required: true,
              options: DEPARTMENT_CATEGORIES,
            },
            { key: 'active', label: '启用（停用后不能再承接新任务）', kind: 'check' },
          ]}
          busy={update.busy}
          error={update.error}
          onClose={() => {
            setEditing(null);
            update.clearError();
          }}
          onSubmit={(values) =>
            void update.save(`/departments/${editing.id}`, {
              name: String(values.name ?? '').trim(),
              category: String(values.category ?? editing.category),
              active: Boolean(values.active),
            })
          }
        />
      ) : null}
    </div>
  );
}

function EmployeePanel({ canEdit }: { canEdit: boolean }) {
  const collection = useCollection<Employee>('/employees?pageSize=200');
  const departments = useCollection<Department>('/departments');
  const [name, setName] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const create = useCreate('/employees', () => {
    setName('');
    setDepartmentId('');
    collection.reload();
  });
  const [editing, setEditing] = useState<Employee | null>(null);
  const update = useUpdate(() => {
    setEditing(null);
    collection.reload();
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !departmentId) return;
    await create.submit({ name: name.trim(), departmentId });
  };

  const toggle = (item: Employee) =>
    void update.save(`/employees/${item.id}`, { active: !item.active });

  return (
    <div className={`data-layout${canEdit ? '' : ' data-layout--single'}`}>
      <Panel title="员工" hint="生产任务必须指派给目标部门的有效员工" count={collection.meta?.total ?? null}>
        <DataTable
          items={collection.items}
          loading={collection.loading}
          error={collection.error}
          emptyTitle="还没有员工"
          onRetry={collection.reload}
          columns={[
            { key: 'code', label: '编码', render: (item) => <span className="mono">{item.code}</span> },
            { key: 'name', label: '姓名', render: (item) => <strong>{item.name}</strong> },
            { key: 'department', label: '部门', render: (item) => item.department.name },
            { key: 'active', label: '状态', render: (item) => <StatusCell active={item.active} /> },
            ...(canEdit
              ? [
                  {
                    key: 'actions',
                    label: '',
                    render: (item: Employee) => (
                      <RowActions
                        active={item.active}
                        onEdit={() => setEditing(item)}
                        onToggle={() => toggle(item)}
                        busy={update.busy}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Panel>

      {canEdit ? (
        <Panel title="新增员工" hint="编码留空时由系统生成" count={null}>
          <form className="stack-form" onSubmit={(event) => void submit(event)}>
            <Field label="员工姓名" htmlFor="employee-name" required>
              <input
                id="employee-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：张师傅"
              />
            </Field>
            <Field label="所属部门" htmlFor="employee-department" required>
              <select
                id="employee-department"
                className="input input--select"
                value={departmentId}
                onChange={(event) => setDepartmentId(event.target.value)}
              >
                <option value="">选择部门</option>
                {departments.items.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </Field>
            {create.error ? <InlineNotice tone="error">{create.error}</InlineNotice> : null}
            {create.saved ? <InlineNotice tone="info">员工已添加。</InlineNotice> : null}
            <Button type="submit" loading={create.submitting} trailing={<PlusIcon size={16} />}>
              添加员工
            </Button>
          </form>
        </Panel>
      ) : null}

      {editing ? (
        <EditDialog
          key={editing.id}
          eyebrow="EDIT EMPLOYEE"
          title={`${editing.code} · ${editing.name}`}
          sub="已有生产任务的员工不能换部门；停用后不会再被指派新任务。"
          initial={{
            name: editing.name,
            departmentId: editing.departmentId,
            active: editing.active,
          }}
          fields={[
            { key: 'name', label: '员工姓名', kind: 'text', required: true },
            {
              key: 'departmentId',
              label: '所属部门',
              kind: 'select',
              required: true,
              options: departments.items
                .filter((item) => item.active !== false)
                .map((item) => ({ value: item.id, label: `${item.name}（${item.code}）` })),
            },
            { key: 'active', label: '启用（停用后不再指派新任务）', kind: 'check' },
          ]}
          busy={update.busy}
          error={update.error}
          onClose={() => {
            setEditing(null);
            update.clearError();
          }}
          onSubmit={(values) =>
            void update.save(`/employees/${editing.id}`, {
              name: String(values.name ?? '').trim(),
              departmentId: String(values.departmentId ?? editing.departmentId),
              active: Boolean(values.active),
            })
          }
        />
      ) : null}
    </div>
  );
}

export function BaseDataPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('customers');
  const canEdit = user?.role === 'ADMIN';
  const activeTab = TABS.find((entry) => entry.key === tab)!;

  return (
    <div className="page">
      <SectionHeading
        eyebrow="MASTER DATA"
        title="基础数据"
        description={
          canEdit
            ? '客户、供应商、配件、部门与员工是订单链路的引用来源。修改这里不会改写历史快照。'
            : '当前角色可以查看基础数据；新增与维护由管理员完成。'
        }
      />

      <div className="tabs" role="tablist" aria-label="基础数据分类">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={`tab${tab === entry.key ? ' tab--active' : ''}`}
            onClick={() => setTab(entry.key)}
          >
            <span className="tab__label">{entry.label}</span>
            <span className="tab__hint">{entry.hint}</span>
          </button>
        ))}
      </div>

      <p className="tab-caption">
        <span className="mono">/ {activeTab.key.toUpperCase()}</span>
        {activeTab.hint}
      </p>

      {tab === 'customers' ? <CustomerPanel canEdit={canEdit} /> : null}
      {tab === 'suppliers' ? <SupplierPanel canEdit={canEdit} /> : null}
      {tab === 'parts' ? <PartPanel canEdit={canEdit} /> : null}
      {tab === 'departments' ? <DepartmentPanel canEdit={canEdit} /> : null}
      {tab === 'employees' ? <EmployeePanel canEdit={canEdit} /> : null}
    </div>
  );
}