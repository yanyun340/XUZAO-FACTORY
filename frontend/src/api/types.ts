export type Role = 'ADMIN' | 'LOGISTICS' | 'PRODUCTION' | 'QC' | 'PACKING';

export type OrderStatus =
  | 'PENDING_PURCHASE'
  | 'PURCHASING'
  | 'IN_PRODUCTION'
  | 'PENDING_QC'
  | 'QC_DONE'
  | 'PACKING'
  | 'SHIPPING'
  | 'COMPLETED';

export interface Department {
  id: string;
  code: string;
  name: string;
  category: 'PRODUCTION' | 'LOGISTICS' | 'QC' | 'PACKING';
  /** 用户 DTO 里的部门是精简结构，只有部门接口会带启用状态。 */
  active?: boolean;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  department: Department | null;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  active: boolean;
  createdAt: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  phone: string | null;
  active: boolean;
  createdAt: string;
}

export interface Part {
  id: string;
  code: string;
  name: string;
  spec: string;
  active: boolean;
  createdAt: string;
}

export interface OrderSummary {
  id: string;
  orderNo: string;
  customerId: string;
  customerName: string;
  customerContact: string | null;
  dueDate: string;
  status: OrderStatus;
  remark: string | null;
  itemCount: number;
  productSummary: string;
  totalQuantity: number;
  totalAmount: string | null;
  moneyVisible: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  allowedActions: string[];
}

export interface OrderItem {
  id: string;
  productName: string;
  spec: string;
  quantity: number;
  unitPrice: string | null;
  lineAmount: string | null;
}

export interface TimelineEntry {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  actorName: string;
}

export type OrderAction =
  | 'create-purchase'
  | 'record-arrival'
  | 'dispatch-production'
  | 'production-feedback'
  | 'dispatch-qc'
  | 'qc-entry'
  | 'qc-decision'
  | 'dispatch-packing'
  | 'record-packing'
  | 'trigger-shipping'
  | 'record-shipment';

export interface FlowQuantities {
  orderQty: number;
  purchaseQty: number;
  arrivedQty: number;
  producedQty: number;
  inspectedQty: number;
  qualifiedQty: number;
  releasedQty: number;
  packedQty: number;
  shippedQty: number;
  dueRemaining: number;
  packableRemaining: number;
  shippableRemaining: number;
}

export interface ArrivalEntry {
  id: string;
  quantity: number;
  operatorName: string;
  createdAt: string;
}

export interface PurchaseItemFlow {
  id: string;
  partName: string;
  partSpec: string;
  quantity: number;
  unitPrice: string | null;
  arrivedQty: number;
  arrivals: ArrivalEntry[];
}

export interface PurchaseFlow {
  id: string;
  supplierName: string;
  createdAt: string;
  items: PurchaseItemFlow[];
}

export interface ProductionFlow {
  id: string;
  departmentName: string;
  departmentCategory: string;
  employeeName: string | null;
  processName: string;
  quantity: number;
  completedQty: number;
  unitPrice: string | null;
  unitPriceVisible: boolean;
  unitPriceForWorker: string | null;
  dueDate: string | null;
  createdAt: string;
  feedback: {
    id: string;
    quantity: number;
    operatorName: string;
    createdAt: string;
  } | null;
}

export interface QcFlow {
  id: string;
  inspectedQty: number;
  qualifiedQty: number;
  unqualifiedQty: number;
  operatorName: string;
  createdAt: string;
  decision: {
    decision: 'PASS' | 'REWORK' | 'SCRAP';
    releasedQty: number;
    decidedByName: string;
    createdAt: string;
  } | null;
}

export interface RecordFlow {
  id: string;
  quantity: number;
  operatorName: string;
  createdAt: string;
}

export interface ProfitFlow {
  sales: string;
  purchaseCost: string;
  productionCost: string;
  profit: string;
  marginPercent: string;
}

export interface OrderFlow {
  quantities: FlowQuantities;
  purchase: PurchaseFlow | null;
  production: ProductionFlow | null;
  qc: QcFlow | null;
  packing: { dispatched: boolean; records: RecordFlow[] };
  shipping: { triggered: boolean; records: RecordFlow[] };
  profit: ProfitFlow | null;
}

export interface OrderDetail extends OrderSummary {
  createdByName: string;
  items: OrderItem[];
  flow: OrderFlow;
  timeline: TimelineEntry[];
}

export interface PageMeta {
  requestId: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** 仅通知列表返回未读总数 */
  unread?: number;
}

export interface Envelope<T> {
  data: T;
  meta: PageMeta;
}

export interface OrderItemInput {
  productName: string;
  spec: string;
  quantity: number;
  unitPrice: string;
}

export interface CreateOrderInput {
  customerId: string;
  customerContact?: string;
  dueDate: string;
  remark?: string;
  items: OrderItemInput[];
}

export interface NotificationItem {
  id: string;
  eventType: string;
  title: string;
  body: string;
  orderId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationSummary {
  unread: number;
  total: number;
}

export interface DashboardData {
  statusCounts: Record<string, number>;
  totalOrders: number;
  production: { tasks: number; completedFeedback: number };
  profit: {
    sales: string;
    purchaseCost: string;
    productionCost: string;
    profit: string;
    marginPercent: string;
  };
  recentOrders: OrderSummary[];
}

export interface PartStock {
  id: string;
  partId: string;
  code: string;
  name: string;
  spec: string;
  active: boolean;
  quantity: number;
  version: number;
  updatedAt: string;
}

export interface ProductStock {
  id: string;
  productName: string;
  spec: string;
  quantity: number;
  version: number;
  updatedAt: string;
}

export interface InventoryLogItem {
  id: string;
  kind: 'PART' | 'PRODUCT';
  target: string;
  before: number;
  delta: number;
  after: number;
  reason: string;
  operatorName: string;
  createdAt: string;
}

export interface AttachmentItem {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  uploadedByName: string | null;
}

export interface ExceptionItem {
  id: string;
  orderId: string | null;
  orderNo: string | null;
  productionOrderId: string | null;
  description: string;
  status: string;
  reporterName: string;
  createdAt: string;
}

export interface LoginResult {
  user: User;
  expiresAt: string;
}

export interface MeResult {
  user: User;
  expiresAt: string;
}
export interface AuditLogItem {
  id: string;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  result: 'SUCCESS' | 'FAILED';
  actorName: string | null;
  actorUsername: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface AuditFacets {
  actions: string[];
  resourceTypes: string[];
  actors: Array<{ id: string; displayName: string }>;
}

export interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  department: Department | null;
  activeSessions: number;
  createdAt: string;
}
