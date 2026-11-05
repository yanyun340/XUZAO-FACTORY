import type { SessionUser } from '../auth/session.ts';

export function toUserDto(user: SessionUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    department: user.department
      ? {
          id: user.department.id,
          code: user.department.code,
          name: user.department.name,
          category: user.department.category,
        }
      : null,
  };
}