import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'ERROR',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, m, 'BAD_REQUEST', d);
export const unauthorized = (m = 'Authentication required') => new AppError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'You do not have permission for this action') => new AppError(403, m, 'FORBIDDEN');
export const notFound = (m = 'Not found') => new AppError(404, m, 'NOT_FOUND');
export const conflict = (m: string) => new AppError(409, m, 'CONFLICT');
export const paymentRequired = (m: string) => new AppError(402, m, 'SUBSCRIPTION_REQUIRED');

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
export const ah =
  (fn: AsyncFn): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
