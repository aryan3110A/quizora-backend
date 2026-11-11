import { Router } from "express";
import argon2 from "argon2";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../lib/http";
import { newToken, sha256, requireAuth } from "../middleware/auth";
import { env } from "../config/env";

export const authRouter=Router();
const loginSchema=z.object({studentId:z.string().trim().min(1).max(80),password:z.string().min(1).max(256)});
authRouter.post("/login",asyncHandler(async(req,res)=>{
 const parsed=loginSchema.safeParse(req.body);if(!parsed.success)throw new HttpError(400,"VALIDATION_ERROR","Enter a valid student ID and password.");
 const user=await prisma.user.findUnique({where:{studentId:parsed.data.studentId}});
 if(!user||!user.isActive||!(await argon2.verify(user.passwordHash,parsed.data.password)))throw new HttpError(401,"INVALID_CREDENTIALS","Student ID or password is incorrect.");
 const raw=newToken();const expiresAt=new Date(Date.now()+8*60*60*1000);
 await prisma.session.create({data:{tokenHash:sha256(raw),userId:user.id,expiresAt}});
 const csrf=newToken();
 res.cookie("quizora_session",raw,{httpOnly:true,secure:env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:expiresAt});
 res.cookie("quizora_csrf",csrf,{httpOnly:false,secure:env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:expiresAt});
 res.setHeader("x-csrf-token",csrf);
 res.json({user:{id:user.id,studentId:user.studentId,fullName:user.fullName,role:user.role,streamId:user.streamId,mustChangePassword:user.mustChangePassword}});
}));
authRouter.post("/logout",asyncHandler(async(req,res)=>{
 const raw=req.cookies?.quizora_session;if(raw)await prisma.session.deleteMany({where:{tokenHash:sha256(raw)}});
 res.clearCookie("quizora_session",{path:"/"});res.clearCookie("quizora_csrf",{path:"/"});
 res.json({ok:true});
}));
authRouter.get("/me",requireAuth,asyncHandler(async(req,res)=>{
 const user=await prisma.user.findUnique({where:{id:req.auth!.userId},include:{stream:true}});
 if(!user)throw new HttpError(401,"UNAUTHENTICATED","Please sign in.");
 res.json({user:{id:user.id,studentId:user.studentId,fullName:user.fullName,role:user.role,stream:user.stream?.code??null,mustChangePassword:user.mustChangePassword}});
}));
authRouter.post("/change-password",requireAuth,asyncHandler(async(req,res)=>{
 const body=z.object({currentPassword:z.string().min(1),newPassword:z.string().min(8).max(128)}).safeParse(req.body);
 if(!body.success)throw new HttpError(400,"VALIDATION_ERROR","New password must be at least 8 characters.");
 const user=await prisma.user.findUniqueOrThrow({where:{id:req.auth!.userId}});
 if(user.role==="STUDENT"&&!user.mustChangePassword){
  throw new HttpError(403,"PASSWORD_CHANGE_LOCKED","You have already changed your password once. If you need to change or reset your password, please contact your department administrator.");
 }
 if(!(await argon2.verify(user.passwordHash,body.data.currentPassword)))throw new HttpError(400,"INVALID_PASSWORD","Current password is incorrect.");
 await prisma.user.update({where:{id:user.id},data:{passwordHash:await argon2.hash(body.data.newPassword),mustChangePassword:false}});
 await prisma.session.deleteMany({where:{userId:user.id}});
 res.clearCookie("quizora_session",{path:"/"});res.clearCookie("quizora_csrf",{path:"/"});
 res.json({ok:true,message:"Password changed successfully. Please sign in with your new password."});
}));
