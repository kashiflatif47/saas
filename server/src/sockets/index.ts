import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../config/env';
import { verifyAccessToken } from '../middleware/auth';
import { User } from '../models/platform';
import { Order } from '../models/operations';
import { isOid, runCrossTenant } from '../models/tenantScope';
import { corsOriginCheck } from '../app.cors';
import { timingSafeEqualStr } from '../lib/crypto';

/**
 * Room layout (all tenant-prefixed so events can never cross tenants):
 *   t:<tenantId>:staff            — all staff dashboards of one tenant
 *   t:<tenantId>:kitchen          — all kitchen screens
 *   t:<tenantId>:station:<id>     — one kitchen station
 *   t:<tenantId>:waiter:<userId>  — one waiter
 *   t:<tenantId>:order:<orderId>  — a customer tracking a single order (token-verified)
 *   platform                       — super admins
 */
let io: Server | null = null;

export function getIO(): Server | null {
  return io;
}

export function initSockets(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: corsOriginCheck, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const { token, orderId, trackingToken } = socket.handshake.auth ?? {};
      if (token) {
        const claims = verifyAccessToken(String(token));
        const user = await User.findById(claims.sub).select('isActive tokenVersion role tenantId stationIds').lean();
        if (!user || !user.isActive || user.tokenVersion !== claims.tv) return next(new Error('unauthorized'));
        socket.data.kind = 'staff';
        socket.data.userId = String(user._id);
        socket.data.role = user.role;
        socket.data.tenantId = user.tenantId ? String(user.tenantId) : null;
        socket.data.stationIds = (user.stationIds ?? []).map(String);
        return next();
      }
      if (orderId && trackingToken && isOid(orderId)) {
        // Customer tracking: tenant derived from the order itself, verified by secret tracking token.
        const order: any = await runCrossTenant(() => Order.findOne({ _id: orderId }).select('+trackingToken').lean().exec());
        if (!order || !timingSafeEqualStr(String(order.trackingToken ?? ''), String(trackingToken))) return next(new Error('unauthorized'));
        socket.data.kind = 'customer';
        socket.data.tenantId = String(order.tenantId);
        socket.data.orderId = String(order._id);
        return next();
      }
      return next(new Error('unauthorized'));
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const { kind, tenantId, role, userId, orderId, stationIds } = socket.data;
    if (kind === 'customer') {
      socket.join(`t:${tenantId}:order:${orderId}`);
      return;
    }
    if (role === 'superadmin') {
      socket.join('platform');
      return;
    }
    socket.join(`u:${userId}`); // lets a revocation close this user's live connections
    socket.join(`t:${tenantId}:role:${role}`);
    // Riders only receive their own deliveries, never the restaurant-wide order feed.
    if (role === 'rider') {
      socket.join(`t:${tenantId}:rider:${userId}`);
      return;
    }
    socket.join(`t:${tenantId}:staff`);
    if (role === 'waiter') socket.join(`t:${tenantId}:waiter:${userId}`);
    if (['kitchen', 'owner', 'admin', 'manager'].includes(role)) socket.join(`t:${tenantId}:kitchen`);
    for (const s of stationIds as string[]) socket.join(`t:${tenantId}:station:${s}`);

    // A kitchen screen can subscribe to a station — only stations are joined with the user's OWN tenant prefix.
    socket.on('kitchen:watchStation', (stationId: unknown) => {
      if (typeof stationId === 'string' && isOid(stationId)) socket.join(`t:${tenantId}:station:${stationId}`);
    });
  });

  return io;
}

/* ---------- Emit helpers (tenant-scoped by construction) ---------- */
export const emit = {
  staff(tenantId: string, event: string, payload: unknown) {
    io?.to(`t:${tenantId}:staff`).emit(event, payload);
  },
  kitchen(tenantId: string, stationIds: string[], event: string, payload: unknown) {
    if (!io) return;
    let target = io.to(`t:${tenantId}:kitchen`);
    for (const s of stationIds) target = target.to(`t:${tenantId}:station:${s}`);
    target.emit(event, payload);
  },
  waiter(tenantId: string, userId: string, event: string, payload: unknown) {
    io?.to(`t:${tenantId}:waiter:${userId}`).emit(event, payload);
  },
  rider(tenantId: string, userId: string, event: string, payload: unknown) {
    io?.to(`t:${tenantId}:rider:${userId}`).emit(event, payload);
  },
  order(tenantId: string, orderId: string, event: string, payload: unknown) {
    io?.to(`t:${tenantId}:order:${orderId}`).emit(event, payload);
  },
  platform(event: string, payload: unknown) {
    io?.to('platform').emit(event, payload);
  },
};

/**
 * Revoking a session (deactivation, role/permission change, password reset, suspension) bumps the
 * token version, which blocks NEW connections. Sockets already open must be closed too, or a removed
 * employee keeps receiving live orders (customer names and phones) until their connection happens to drop.
 */
export function disconnectUserSockets(userId: string) {
  io?.in(`u:${userId}`).disconnectSockets(true);
}

/** Closes every staff connection of a tenant (used when the platform suspends it). */
export function disconnectTenantStaffSockets(tenantId: string) {
  io?.in(`t:${tenantId}:staff`).disconnectSockets(true);
}

export const socketConfig ={ path: '/socket.io', root: env.ROOT_DOMAIN };
