import type { Request, Response, NextFunction } from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "../lib/prisma";
import { HttpError } from "../lib/http";
import { env } from "../config/env";

export function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function requireAuth(req: Request,res: Response,next: NextFunction) {
  void (async()=>{
    const token=req.cookies?.quizora_session;
    if(!token) throw new HttpError(401,"UNAUTHENTICATED","Please sign in.");
    const session=await prisma.session.findUnique({where:{tokenHash:sha256(token)},include:{user:true}});
    if(!session||session.expiresAt<=new Date()||!session.user.isActive) throw new HttpError(401,"UNAUTHENTICATED","Session expired. Please sign in again.");
    req.auth={userId:session.user.id,role:session.user.role,studentId:session.user.studentId,streamId:session.user.streamId};
    next();
  })().catch(next);
}
export function requireAdmin(req: Request,_res: Response,next: NextFunction) {
  if(req.auth?.role!=="ADMIN") return next(new HttpError(403,"FORBIDDEN","Administrator access is required."));
  next();
}
export function csrfProtection(req: Request,res: Response,next: NextFunction) {
  if(["GET","HEAD","OPTIONS"].includes(req.method)) {
    let token = req.cookies?.quizora_csrf;
    if(!token) {
      token = newToken();
      res.cookie("quizora_csrf", token, {
        httpOnly: false,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        expires: new Date(Date.now() + 8 * 60 * 60 * 1000)
      });
    }
    res.setHeader("x-csrf-token", token);
    return next();
  }
  const origin=req.get("origin");
  if(origin && origin!==env.FRONTEND_ORIGIN) return next(new HttpError(403,"BAD_ORIGIN","Request origin is not allowed."));
  const cookie=req.cookies?.quizora_csrf;
  const header=req.get("x-csrf-token");
  if(!cookie||!header) return next(new HttpError(403,"CSRF_REQUIRED","Missing CSRF token."));
  const a=Buffer.from(cookie);const b=Buffer.from(header);
  if(a.length!==b.length||!timingSafeEqual(a,b)) return next(new HttpError(403,"CSRF_INVALID","Invalid CSRF token."));
  res.setHeader("x-csrf-token", cookie);
  next();
}
export function newToken(){return randomBytes(32).toString("base64url");}
