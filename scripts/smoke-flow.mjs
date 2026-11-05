/**
 * 主线冒烟脚本：建单 → 采购 → 到货 → 生产 → 质检 → 放行 → 包装 → 发货 → 完成。
 * 只连本地开发环境，使用合成数据；每次运行都会新建一张订单。
 *
 *   node scripts/smoke-flow.mjs            # 默认 http://127.0.0.1:3001
 *   BASE_URL=... node scripts/smoke-flow.mjs
 */
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api/v1`;
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'XuZao-demo-2026';

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`, detail ?? '');
  }
}

async function login(username) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const raw = response.headers.getSetCookie?.() ?? [];
  const cookie = raw.map((value) => value.split(';')[0]).join('; ');
  if (!response.ok || !cookie) {
    throw new Error(`登录失败 ${username}: ${response.status} ${await response.text()}`);
  }
  return cookie;
}

async function call(cookie, method, path, { body, key } = {}) {
  const headers = { cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload, headers: response.headers };
}

function expectOk(label, result, expected = 200) {
  const ok = result.status === expected;
  check(label, ok, result.status !== expected ? `${result.status} ${JSON.stringify(result.payload)}` : '');
  return result.payload.data;
}

function expectFail(label, result, expectedStatus, expectedCode) {
  const code = result.payload?.error?.code;
  check(
    label,
    result.status === expectedStatus && code === expectedCode,
    `${result.status} ${code} ${JSON.stringify(result.payload).slice(0, 160)}`,
  );
}

async function main() {
  console.log(`序造主线冒烟 @ ${BASE}`);
  const admin = await login('admin');
  const logistics = await login('logistics');
  const production = await login('production');
  const qc = await login('qc');
  const packing = await login('packing');

  const customers = (await call(admin, 'GET', '/customers?pageSize=50')).payload.data;
  const suppliers = (await call(admin, 'GET', '/suppliers?pageSize=50')).payload.data;
  const parts = (await call(admin, 'GET', '/parts?pageSize=50')).payload.data;
  const departments = (await call(admin, 'GET', '/departments?pageSize=50')).payload.data;

  const customer = customers[0];
  const supplier = suppliers[0];
  const part = parts[0];
  const productionDept = departments.find((d) => d.category === 'PRODUCTION');
  if (!customer || !supplier || !part || !productionDept) {
    throw new Error('演示基础数据缺失，请先运行 npm run seed');
  }

  console.log('\n[1] 创建订单');
  const created = expectOk(
    '创建订单 201',
    await call(admin, 'POST', '/orders', {
      key: randomUUID(),
      body: {
        customerId: customer.id,
        dueDate: '2026-11-30',
        remark: '主线冒烟脚本',
        items: [{ productName: '冒烟测试联轴器', spec: 'SM-01', quantity: 20, unitPrice: '50.00' }],
      },
    }),
    201,
  );
  const orderId = created.id;

  console.log('\n[2] 采购');
  const purchased = expectOk(
    '创建采购单 201',
    await call(admin, 'POST', `/orders/${orderId}/purchase`, {
      key: randomUUID(),
      body: { supplierId: supplier.id, partId: part.id, quantity: 20, unitPrice: '12.50' },
    }),
    201,
  );
  check('状态进入 PURCHASING', purchased.status === 'PURCHASING', purchased.status);
  check('金额可见（管理员）', purchased.totalAmount === '1000.00', purchased.totalAmount);

  const purchaseId = purchased.flow.purchase.id;

  console.log('\n[3] 到货闸门');
  expectFail(
    '超量到货被拒绝',
    await call(logistics, 'POST', `/purchases/${purchaseId}/arrivals`, {
      key: randomUUID(),
      body: { quantity: 21 },
    }),
    422,
    'ARRIVAL_EXCEEDS_REMAINING',
  );
  expectFail(
    '生产下发前必须全部到货',
    await call(admin, 'POST', `/orders/${orderId}/productions`, {
      key: randomUUID(),
      body: {
        departmentId: productionDept.id,
        processName: '机加工',
        quantity: 20,
        unitPrice: '6.00',
        unitPriceVisible: false,
      },
    }),
    422,
    'ARRIVAL_INCOMPLETE',
  );

  console.log('\n[4] 到货');
  const arrived = expectOk(
    '到货 20 件',
    await call(logistics, 'POST', `/purchases/${purchaseId}/arrivals`, {
      key: randomUUID(),
      body: { quantity: 20 },
    }),
    201,
  );
  check('累计到货 20', arrived.flow.quantities.arrivedQty === 20, arrived.flow.quantities.arrivedQty);

  console.log('\n[5] 生产');
  expectFail(
    '生产角色不能下发任务',
    await call(production, 'POST', `/orders/${orderId}/productions`, {
      key: randomUUID(),
      body: { departmentId: productionDept.id, processName: 'x', quantity: 1, unitPrice: '1.00' },
    }),
    403,
    'FORBIDDEN',
  );

  const dispatched = expectOk(
    '下发生产 201',
    await call(admin, 'POST', `/orders/${orderId}/productions`, {
      key: randomUUID(),
      body: {
        departmentId: productionDept.id,
        processName: '机加工',
        quantity: 20,
        unitPrice: '6.00',
        unitPriceVisible: false,
      },
    }),
    201,
  );
  check('状态进入 IN_PRODUCTION', dispatched.status === 'IN_PRODUCTION', dispatched.status);
  const productionId = dispatched.flow.production.id;

  const workerView = (await call(production, 'GET', `/orders/${orderId}`)).payload.data;
  check('生产角色看不到订单金额', workerView.totalAmount === null, workerView.totalAmount);
  check(
    '生产单价未放开时不显示',
    workerView.flow.production.unitPrice === null,
    workerView.flow.production.unitPrice,
  );

  expectFail(
    '反馈超过任务量被拒绝',
    await call(production, 'POST', `/productions/${productionId}/feedback`, {
      key: randomUUID(),
      body: { quantity: 21 },
    }),
    422,
    'FEEDBACK_EXCEEDS_TASK',
  );

  const feedback = expectOk(
    '生产反馈 20 件',
    await call(production, 'POST', `/productions/${productionId}/feedback`, {
      key: randomUUID(),
      body: { quantity: 20 },
    }),
    201,
  );
  check('已生产 20', feedback.flow.quantities.producedQty === 20, feedback.flow.quantities.producedQty);

  console.log('\n[6] 质检');
  const qcDispatched = expectOk(
    '下发质检',
    await call(admin, 'POST', `/orders/${orderId}/qc-dispatch`, { key: randomUUID(), body: {} }),
    201,
  );
  check('状态进入 PENDING_QC', qcDispatched.status === 'PENDING_QC', qcDispatched.status);
  const qcView = (await call(qc, 'GET', `/orders/${orderId}`)).payload.data;
  check('品控可见录入动作', qcView.allowedActions.includes('qc-entry'), qcView.allowedActions);

  expectFail(
    '部分不合格在 M 版本被拒绝',
    await call(qc, 'POST', `/productions/${productionId}/qc-records`, {
      key: randomUUID(),
      body: { inspectedQty: 20, qualifiedQty: 18, unqualifiedQty: 2 },
    }),
    422,
    'QC_PARTIAL_NOT_SUPPORTED',
  );

  const qcRecorded = expectOk(
    '品控录入全合格 20',
    await call(qc, 'POST', `/productions/${productionId}/qc-records`, {
      key: randomUUID(),
      body: { inspectedQty: 20, qualifiedQty: 20, unqualifiedQty: 0 },
    }),
    201,
  );
  check('品控保存不等于放行', qcRecorded.status === 'PENDING_QC', qcRecorded.status);
  check('可包装量仍为 0', qcRecorded.flow.quantities.releasedQty === 0, qcRecorded.flow.quantities.releasedQty);

  const qcRecordId = qcRecorded.flow.qc.id;
  expectFail(
    '返工 / 报废在 M 版本被明确拒绝',
    await call(admin, 'POST', `/qc-records/${qcRecordId}/decision`, {
      key: randomUUID(),
      body: { decision: 'REWORK' },
    }),
    422,
    'QC_DECISION_NOT_SUPPORTED',
  );

  console.log('\n[7] 管理员放行');
  const passed = expectOk(
    'PASS 放行 20',
    await call(admin, 'POST', `/qc-records/${qcRecordId}/decision`, {
      key: randomUUID(),
      body: { decision: 'PASS' },
    }),
    201,
  );
  check('状态进入 QC_DONE', passed.status === 'QC_DONE', passed.status);
  check('放行量 20', passed.flow.quantities.releasedQty === 20, passed.flow.quantities.releasedQty);

  console.log('\n[8] 包装');
  const packingDispatched = expectOk(
    '下发包装',
    await call(admin, 'POST', `/orders/${orderId}/packing-dispatch`, { key: randomUUID(), body: {} }),
    201,
  );
  check('状态进入 PACKING', packingDispatched.status === 'PACKING', packingDispatched.status);

  expectFail(
    '超量包装被拒绝',
    await call(packing, 'POST', `/orders/${orderId}/packing-records`, {
      key: randomUUID(),
      body: { quantity: 21 },
    }),
    422,
    'PACKING_EXCEEDS_REMAINING',
  );

  const packed = expectOk(
    '包装 20',
    await call(packing, 'POST', `/orders/${orderId}/packing-records`, {
      key: randomUUID(),
      body: { quantity: 20 },
    }),
    201,
  );
  check('已包装 20', packed.flow.quantities.packedQty === 20, packed.flow.quantities.packedQty);

  console.log('\n[9] 发货');
  const shipping = expectOk(
    '触发发货',
    await call(admin, 'POST', `/orders/${orderId}/shipping-trigger`, { key: randomUUID(), body: {} }),
    201,
  );
  check('状态进入 SHIPPING', shipping.status === 'SHIPPING', shipping.status);

  expectFail(
    '超过应交剩余的发货被拒绝',
    await call(logistics, 'POST', `/orders/${orderId}/shipment-records`, {
      key: randomUUID(),
      body: { quantity: 21 },
    }),
    422,
    'SHIPMENT_EXCEEDS_LIMIT',
  );

  const shipped = expectOk(
    '发货 20',
    await call(logistics, 'POST', `/orders/${orderId}/shipment-records`, {
      key: randomUUID(),
      body: { quantity: 20 },
    }),
    201,
  );
  check('状态 COMPLETED', shipped.status === 'COMPLETED', shipped.status);
  check('应交剩余 0', shipped.flow.quantities.dueRemaining === 0, shipped.flow.quantities.dueRemaining);

  console.log('\n[10] 利润口径');
  const finalView = (await call(admin, 'GET', `/orders/${orderId}`)).payload.data;
  const profit = finalView.flow.profit;
  check('销售额 1000.00', profit.sales === '1000.00', profit.sales);
  check('采购成本 250.00', profit.purchaseCost === '250.00', profit.purchaseCost);
  check('生产成本 120.00', profit.productionCost === '120.00', profit.productionCost);
  check('利润 630.00', profit.profit === '630.00', profit.profit);
  check('毛利率 63.00', profit.marginPercent === '63.00', profit.marginPercent);

  console.log(`\n订单 ${shipped.orderNo} · ${orderId}`);
  console.log(failures === 0 ? '\n全部通过' : `\n失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});