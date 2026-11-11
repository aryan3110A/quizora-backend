import type { Request, Response, NextFunction } from "express";
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req,res,next)).catch(next);
}
