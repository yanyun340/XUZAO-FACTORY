import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { prisma } from '../db.ts';
import type { AdminUser, Department, Session } from '../generated/prisma/client.ts';

export type SessionUser = AdminUser & { department: Department | null };

export interface SessionContext {
  session: Session;
  user: SessionUser;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function findSessionContext(token: string): Promise<SessionContext | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { department: true } } },
  });

  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  if (!session.user.active) return null;

  const { user, ...rest } = session;
  return { session: rest, user };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** 停用账号或改角色时调用：所有已签发会话立即失效。 */
export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.adminUser.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    }),
  ]);
}