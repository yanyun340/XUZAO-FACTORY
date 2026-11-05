/**
 * 合成演示数据。只用于本地开发与验收，不包含任何真实客户或员工信息。
 * 可重复执行：按唯一业务键 upsert，不会重复造数据。
 */
import { hashPassword } from '../src/auth/password.ts';
import { config } from '../src/config.ts';
import { prisma } from '../src/db.ts';
import { syncCodeSequences } from '../src/lib/sequence-sync.ts';
import { parseDateOnly } from '../src/lib/time.ts';

async function main(): Promise<void> {
  if (config.isProduction) {
    throw new Error('演示数据禁止写入生产环境');
  }
  if (!config.seedDemoPassword) {
    throw new Error('请先在 backend/.env 设置 SEED_DEMO_PASSWORD（至少 8 位）');
  }

  const passwordHash = await hashPassword(config.seedDemoPassword);

  const departments = [
    { code: 'PROD', name: '生产部', category: 'PRODUCTION' as const },
    { code: 'LOGI', name: '物流部', category: 'LOGISTICS' as const },
    { code: 'QC', name: '品控部', category: 'QC' as const },
    { code: 'PACK', name: '包装部', category: 'PACKING' as const },
  ];

  const departmentMap = new Map<string, string>();
  for (const department of departments) {
    const record = await prisma.department.upsert({
      where: { code: department.code },
      create: department,
      update: { name: department.name, category: department.category, active: true },
    });
    departmentMap.set(department.code, record.id);
  }

  const users = [
    { username: 'admin', displayName: '管理员', role: 'ADMIN' as const, department: null },
    { username: 'logistics', displayName: '物流专员', role: 'LOGISTICS' as const, department: 'LOGI' },
    { username: 'production', displayName: '生产主管', role: 'PRODUCTION' as const, department: 'PROD' },
    { username: 'qc', displayName: '品控专员', role: 'QC' as const, department: 'QC' },
    { username: 'packing', displayName: '包装专员', role: 'PACKING' as const, department: 'PACK' },
  ];

  for (const user of users) {
    await prisma.adminUser.upsert({
      where: { username: user.username },
      create: {
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        departmentId: user.department ? departmentMap.get(user.department) : null,
        passwordHash,
      },
      update: {
        displayName: user.displayName,
        role: user.role,
        departmentId: user.department ? departmentMap.get(user.department) : null,
        passwordHash,
        active: true,
      },
    });
  }

  const customers = [
    { code: 'CUS-0001', name: '宁波精密机械有限公司', contact: '王工', phone: '0574-5550-1001' },
    { code: 'CUS-0002', name: '苏州恒达自动化设备厂', contact: '李经理', phone: '0512-5550-2002' },
    { code: 'CUS-0003', name: '合肥新材科技有限公司', contact: '周主管', phone: '0551-5550-3003' },
  ];
  for (const customer of customers) {
    await prisma.customer.upsert({
      where: { code: customer.code },
      create: customer,
      update: { name: customer.name, contact: customer.contact, phone: customer.phone, active: true },
    });
  }

  const suppliers = [
    { code: 'SUP-0001', name: '无锡恒信金属材料有限公司', contact: '陈经理', phone: '0510-5550-4001' },
    { code: 'SUP-0002', name: '常州表面处理有限公司', contact: '赵工', phone: '0519-5550-5002' },
  ];
  for (const supplier of suppliers) {
    await prisma.supplier.upsert({
      where: { code: supplier.code },
      create: supplier,
      update: { name: supplier.name, contact: supplier.contact, phone: supplier.phone, active: true },
    });
  }

  const parts = [
    { code: 'PRT-0001', name: '304 不锈钢法兰', spec: 'DN50 / 厚 8mm', quantity: 120 },
    { code: 'PRT-0002', name: '铝合金支架', spec: '6061 / 120×80mm', quantity: 80 },
    { code: 'PRT-0003', name: '六角螺栓', spec: 'M8×30 / 304 不锈钢', quantity: 500 },
  ];
  for (const { quantity, ...part } of parts) {
    const created = await prisma.part.upsert({
      where: { code: part.code },
      create: { ...part, inventory: { create: { quantity } } },
      update: { name: part.name, spec: part.spec, active: true },
    });
    // 旧库补齐：已有配件但缺库存台账时补一条
    await prisma.partInventory.upsert({
      where: { partId: created.id },
      create: { partId: created.id, quantity },
      update: {},
    });
  }

  const employees = [
    { code: 'EMP-0001', name: '张师傅', department: 'PROD' },
    { code: 'EMP-0002', name: '刘师傅', department: 'PROD' },
    { code: 'EMP-0003', name: '孙检验', department: 'QC' },
    { code: 'EMP-0004', name: '吴包装', department: 'PACK' },
  ];
  for (const employee of employees) {
    const departmentId = departmentMap.get(employee.department);
    if (!departmentId) throw new Error(`缺少部门 ${employee.department}`);
    await prisma.employee.upsert({
      where: { code: employee.code },
      create: { code: employee.code, name: employee.name, departmentId },
      update: { name: employee.name, departmentId, active: true },
    });
  }

  const admin = await prisma.adminUser.findUniqueOrThrow({ where: { username: 'admin' } });
  const demoCustomer = await prisma.customer.findUniqueOrThrow({ where: { code: 'CUS-0001' } });
  const dueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  await prisma.order.upsert({
    where: { orderNo: 'XZ-20261103-9001' },
    create: {
      orderNo: 'XZ-20261103-9001',
      customerId: demoCustomer.id,
      customerName: demoCustomer.name,
      customerContact: demoCustomer.contact,
      dueDate: parseDateOnly(dueDate.toISOString().slice(0, 10)),
      remark: '演示订单：一单到底最小闭环',
      status: 'PENDING_PURCHASE',
      createdById: admin.id,
      items: {
        create: [
          {
            productName: '不锈钢法兰组件',
            spec: 'DN50 / 8mm / 拉丝面',
            quantity: 100,
            unitPrice: '12.50',
          },
        ],
      },
    },
    update: {},
  });

  await prisma.productInventory.upsert({
    where: { productKey: '不锈钢法兰组件|dn50 / 8mm / 拉丝面' },
    create: {
      productKey: '不锈钢法兰组件|dn50 / 8mm / 拉丝面',
      productName: '不锈钢法兰组件',
      spec: 'DN50 / 8mm / 拉丝面',
      quantity: 40,
    },
    update: {},
  });

  // 种子数据的编码是写死的，必须把自动取号计数器抬上去，否则新建第一条就撞唯一键
  await syncCodeSequences(prisma);

  const counts = {
    departments: await prisma.department.count(),
    users: await prisma.adminUser.count(),
    customers: await prisma.customer.count(),
    suppliers: await prisma.supplier.count(),
    parts: await prisma.part.count(),
    employees: await prisma.employee.count(),
    orders: await prisma.order.count(),
  };

  console.log('[seed] 演示数据已就绪');
  console.table(counts);
  console.log(`[seed] 登录账号：admin / <SEED_DEMO_PASSWORD>，其余账号 logistics、production、qc、packing`);
}

main()
  .catch((error) => {
    console.error('[seed] 失败：', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });