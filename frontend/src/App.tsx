import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LiveAnnouncer } from './components/LiveAnnouncer';
import { Spinner } from './components/ui';
import { AuditLogPage } from './pages/AuditLogPage';
import { BaseDataPage } from './pages/BaseDataPage';
import { DashboardPage } from './pages/DashboardPage';
import { ExceptionsPage } from './pages/ExceptionsPage';
import { InventoryPage } from './pages/InventoryPage';
import { LoginPage } from './pages/LoginPage';
import { NewOrderPage } from './pages/NewOrderPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { TasksPage } from './pages/TasksPage';
import { UsersPage } from './pages/UsersPage';

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="boot">
        <Spinner label="正在确认登录状态" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== 'ADMIN') {
    return <Navigate to="/orders" replace />;
  }
  return <Outlet />;
}

function NotFound() {
  return (
    <div className="not-found">
      <p className="eyebrow">404</p>
      <h1>页面不存在</h1>
      <p>链接可能已失效，或者你输入了错误的地址。</p>
      <a className="text-link" href="/orders">
        返回订单总览
      </a>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <LiveAnnouncer />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="orders" element={<OrdersPage />} />
            <Route path="orders/new" element={<NewOrderPage />} />
            <Route path="orders/:id" element={<OrderDetailPage />} />
            <Route path="inventory" element={<InventoryPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="base-data" element={<BaseDataPage />} />
            <Route element={<RequireAdmin />}>
              <Route path="exceptions" element={<ExceptionsPage />} />
              <Route path="audit" element={<AuditLogPage />} />
              <Route path="users" element={<UsersPage />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}