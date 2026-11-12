import type { Types } from 'mongoose';
import type { Role } from '../config/permissions';

export interface AuthUser {
  id: string;
  tenantId: string | null;
  role: Role;
  name: string;
  permissionOverrides?: { grant?: string[]; revoke?: string[] };
}

export interface ResolvedTenant {
  _id: Types.ObjectId;
  id: string;
  slug: string;
  name: string;
  status: string;
  settings: any;
  subscription: any;
  features: Set<string>;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: ResolvedTenant;
      /** Shortcut to the tenant ObjectId — always set by requireTenant. */
      tenantId?: Types.ObjectId;
      rawBody?: Buffer;
    }
  }
}
