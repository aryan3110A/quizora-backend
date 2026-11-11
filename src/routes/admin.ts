import { Router } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import * as XLSX from "xlsx";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../lib/http";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { env } from "../config/env";

export const adminRouter=Router();
adminRouter.use(requireAuth,requireAdmin);
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:env.IMPORT_MAX_BYTES,files:1}});
type ParsedQuestion={question:string;optionA:string;optionB:string;optionC:string;optionD:string;correctAnswer:"A"|"B"|"C"|"D";explanation?:string;topic?:string;marks:number;negativeMarks:number;difficulty?:string;row:number};
const imports=new Map<string,{adminId:string;quizId:string;expires:number;questions:ParsedQuestion[]}>();
const quizSchema=z.object({title:z.string().trim().min(3).max(180),description:z.string().max(2000).optional(),startsAt:z.string().datetime(),endsAt:z.string().datetime(),durationMinutes:z.number().int().min(1).max(360),defaultMarks:z.number().positive().max(100),streamCodes:z.array(z.string().min(1)).min(1)});
adminRouter.get("/dashboard",asyncHandler(async(_req,res)=>{
 const [students,quizzes,scheduled,attempts,recentQuizzes,streamsBreakdown,recentAttempts,publishedQuizzesCount,draftQuizzesCount]=await Promise.all([
  prisma.user.count({where:{role:"STUDENT"}}),
  prisma.quiz.count(),
  prisma.quiz.count({where:{status:"PUBLISHED",startsAt:{gt:new Date()}}}),
  prisma.attempt.count(),
  prisma.quiz.findMany({orderBy:{createdAt:"desc"},take:20,select:{id:true,title:true,status:true,startsAt:true,endsAt:true,_count:{select:{questions:true}},streams:{select:{stream:{select:{code:true}}}}}}),
  prisma.stream.findMany({select:{code:true,name:true,_count:{select:{users:{where:{role:"STUDENT"}}}}}}),
  prisma.attempt.findMany({orderBy:{createdAt:"desc"},take:8,select:{id:true,status:true,score:true,totalMarks:true,createdAt:true,user:{select:{studentId:true,fullName:true}},quiz:{select:{title:true}}}}),
  prisma.quiz.count({where:{status:"PUBLISHED"}}),
  prisma.quiz.count({where:{status:"DRAFT"}})
 ]);
 const formattedQuizzes=recentQuizzes.map(q=>({id:q.id,title:q.title,status:q.status,startsAt:q.startsAt,endsAt:q.endsAt,questionCount:q._count.questions,streamCodes:q.streams.map(s=>s.stream.code)}));
 res.json({
  stats:{
    students,
    quizzes,
    scheduled,
    attempts,
    publishedQuizzes:publishedQuizzesCount,
    draftQuizzes:draftQuizzesCount
  },
  streamsBreakdown:streamsBreakdown.map(s=>({code:s.code,name:s.name,count:s._count.users})),
  recentAttempts:recentAttempts.map(a=>({
    id:a.id,
    studentId:a.user.studentId,
    fullName:a.user.fullName,
    quizTitle:a.quiz.title,
    score:a.score,
    totalMarks:a.totalMarks,
    status:a.status,
    createdAt:a.createdAt
  })),
  recentQuizzes:formattedQuizzes
 });
}));
adminRouter.get("/students",asyncHandler(async(_req,res)=>{
 const students=await prisma.user.findMany({where:{role:"STUDENT"},orderBy:{studentId:"asc"},take:500,include:{stream:true}});
 res.json({students:students.map(s=>({id:s.id,studentId:s.studentId,fullName:s.fullName,stream:s.stream?.code??"UNASSIGNED",isActive:s.isActive,mustChangePassword:s.mustChangePassword}))});
}));
adminRouter.post("/students",asyncHandler(async(req,res)=>{
 const body=z.object({studentId:z.string().trim().min(1).max(80),fullName:z.string().trim().min(2).max(160),password:z.string().min(8).max(128),streamCode:z.string().min(1)}).safeParse(req.body);
 if(!body.success)throw new HttpError(400,"VALIDATION_ERROR","Invalid student data. Password must be at least 8 characters.");
 const argon2=(await import("argon2")).default;
 const stream=await prisma.stream.findUnique({where:{code:body.data.streamCode}});if(!stream)throw new HttpError(400,"INVALID_STREAM","Unknown stream code.");
 const user=await prisma.user.create({data:{studentId:body.data.studentId,fullName:body.data.fullName,passwordHash:await argon2.hash(body.data.password),streamId:stream.id,mustChangePassword:true}});
 res.status(201).json({id:user.id,studentId:user.studentId});
}));
adminRouter.post("/students/:id/reset-password",asyncHandler(async(req,res)=>{
 const student=await prisma.user.findFirst({where:{id:String(req.params.id),role:"STUDENT"}});
 if(!student)throw new HttpError(404,"STUDENT_NOT_FOUND","Student not found.");
 const argon2=(await import("argon2")).default;
 const resetPassword=student.studentId;
 const hash=await argon2.hash(resetPassword);
 await prisma.user.update({where:{id:student.id},data:{passwordHash:hash,mustChangePassword:true}});
 await prisma.session.deleteMany({where:{userId:student.id}});
 res.json({ok:true,message:`Password for ${student.studentId} has been reset to their Student ID. They may now set a new password on login.`});
}));
adminRouter.post("/quizzes",asyncHandler(async(req,res)=>{
 const parsed=quizSchema.safeParse(req.body);if(!parsed.success)throw new HttpError(400,"VALIDATION_ERROR","Invalid quiz details.");
 const d=parsed.data;const start=new Date(d.startsAt),end=new Date(d.endsAt);
 if(end<=start)throw new HttpError(400,"INVALID_SCHEDULE","Closing time must be after start time.");
 if(end.getTime()-start.getTime()<d.durationMinutes*60_000){} // Late starters are capped at quiz close.
 const streams=await prisma.stream.findMany({where:{code:{in:d.streamCodes}}});
 if(streams.length!==new Set(d.streamCodes).size)throw new HttpError(400,"INVALID_STREAM","One or more stream codes are unknown.");
 const quiz=await prisma.quiz.create({data:{title:d.title,description:d.description,startsAt:start,endsAt:end,durationMinutes:d.durationMinutes,defaultMarks:d.defaultMarks,streams:{create:streams.map(s=>({streamId:s.id}))}}});
 res.status(201).json({id:quiz.id,status:quiz.status,title:quiz.title});
}));
adminRouter.post("/quizzes/:quizId/publish",asyncHandler(async(req,res)=>{
 const quizId=String(req.params.quizId);
 const quiz=await prisma.quiz.findUnique({where:{id:quizId},include:{questions:{include:{options:true}},streams:true}});
 if(!quiz)throw new HttpError(404,"QUIZ_NOT_FOUND","Quiz not found.");
 if(quiz.status!=="DRAFT")throw new HttpError(409,"INVALID_STATE","Only a draft can be published.");
 if(quiz.questions.length===0)throw new HttpError(400,"NO_QUESTIONS","Add questions before publishing.");
 for(const q of quiz.questions){if(q.options.length<2||q.options.filter(o=>o.isCorrect).length!==1)throw new HttpError(400,"INVALID_QUESTION",`Question at position ${q.position} must have options and exactly one correct answer.`);}
 const updated=await prisma.quiz.update({where:{id:quiz.id},data:{status:"PUBLISHED",publishedAt:new Date()}});
 res.json({id:updated.id,status:updated.status});
}));
adminRouter.post("/quizzes/:quizId/streams",asyncHandler(async(req,res)=>{
 const quizId=String(req.params.quizId);
 const parsed=z.object({streamCodes:z.array(z.string().min(1)).min(1)}).safeParse(req.body);
 if(!parsed.success)throw new HttpError(400,"VALIDATION_ERROR","Stream codes must be a non-empty array of strings.");
 const streams=await prisma.stream.findMany({where:{code:{in:parsed.data.streamCodes}}});
 if(streams.length!==new Set(parsed.data.streamCodes).size)throw new HttpError(400,"INVALID_STREAM","One or more stream codes are unknown.");
 for(const s of streams){
  await prisma.quizStream.upsert({where:{quizId_streamId:{quizId,streamId:s.id}},create:{quizId,streamId:s.id},update:{}});
 }
 res.json({ok:true,message:"Streams updated successfully."});
}));
adminRouter.post("/quizzes/:quizId/questions/import/preview",upload.single("file"),asyncHandler(async(req,res)=>{
 if(!req.file)throw new HttpError(400,"FILE_REQUIRED","Upload a CSV or XLSX file.");
 const ext=req.file.originalname.toLowerCase().split(".").pop();
 if(!["csv","xlsx"].includes(ext??""))throw new HttpError(400,"INVALID_FILE_TYPE","Only CSV and XLSX files are supported.");
 const quizId=String(req.params.quizId);
 const quiz=await prisma.quiz.findUnique({where:{id:quizId}});
 if(!quiz||quiz.status!=="DRAFT")throw new HttpError(404,"DRAFT_NOT_FOUND","A draft quiz is required.");
 let workbook:XLSX.WorkBook;
 try{workbook=XLSX.read(req.file.buffer,{type:"buffer",cellDates:false});}catch{throw new HttpError(400,"INVALID_FILE","File could not be parsed.");}
 const first=workbook.SheetNames[0];if(!first)throw new HttpError(400,"EMPTY_FILE","Workbook has no sheets.");
 const rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(workbook.Sheets[first],{defval:"",raw:false});
 if(rows.length===0)throw new HttpError(400,"EMPTY_FILE","No question rows found.");
 if(rows.length>env.IMPORT_MAX_ROWS)throw new HttpError(413,"TOO_MANY_ROWS",`Maximum ${env.IMPORT_MAX_ROWS} question rows per import.`);
 const errors:Array<{row:number;message:string}>=[];
 const questions:ParsedQuestion[]=[];
 const normalize=(r:Record<string,unknown>)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k.trim().toLowerCase().replace(/[\s_-]/g,""),String(v??"").trim()]));
 rows.forEach((raw,i)=>{
  const r=normalize(raw);const row=i+2;
  const q=r.question??"";const a=r.optiona??"";const b=r.optionb??"";const c=r.optionc??"";const d=r.optiond??"";
  const rawCorrect=(r.correctanswer||r["correctoption&explanation"]||r.correctoptionexplanation||r.correctoption||r.answer||r.correct||"").trim();
  const match=rawCorrect.match(/^([A-Da-d])(?:\s*[\u2014\u2013\-:.)]\s*(.*))?$/);
  const correct=match?match[1].toUpperCase():(["A","B","C","D"].includes(rawCorrect.toUpperCase())?rawCorrect.toUpperCase():"");
  const explanation=r.explanation||(match&&match[2]?match[2].trim():undefined);
  if(!q||!a||!b||!c||!d){errors.push({row,message:"Question and all four options are required."});return;}
  if(!["A","B","C","D"].includes(correct)){errors.push({row,message:"CorrectAnswer must be A, B, C, or D."});return;}
  const marksRaw=r.marks;const negRaw=r.negativemarks;
  const marks=marksRaw?Number(marksRaw):quiz.defaultMarks;const negativeMarks=negRaw?Number(negRaw):0;
  if(!Number.isFinite(marks)||marks<=0||!Number.isFinite(negativeMarks)||negativeMarks<0){errors.push({row,message:"Marks must be positive and NegativeMarks must be non-negative numbers."});return;}
  const difficulty=(r.difficulty??"").toLowerCase();
  if(difficulty&&!["easy","medium","hard"].includes(difficulty)){errors.push({row,message:"Difficulty must be Easy, Medium, or Hard."});return;}
  questions.push({question:q,optionA:a,optionB:b,optionC:c,optionD:d,correctAnswer:correct as ParsedQuestion["correctAnswer"],explanation:explanation||undefined,topic:r.topic||undefined,marks,negativeMarks,difficulty:difficulty||undefined,row});
 });
 const seen=new Set<string>();
 for(const q of questions){const key=q.question.toLowerCase().replace(/\s+/g," ");if(seen.has(key))errors.push({row:q.row,message:"Duplicate question text in this file."});seen.add(key);}
 const importId=randomUUID();imports.set(importId,{adminId:req.auth!.userId,quizId:quiz.id,expires:Date.now()+15*60_000,questions});
 res.json({importId,validCount:questions.length,errors,questions:questions.map(q=>({question:q.question,optionA:q.optionA,optionB:q.optionB,optionC:q.optionC,optionD:q.optionD,correctAnswer:q.correctAnswer,topic:q.topic,explanation:q.explanation,marks:q.marks,row:q.row}))});
}));
adminRouter.post("/quizzes/:quizId/questions/import/confirm",asyncHandler(async(req,res)=>{
 const body=z.object({importId:z.string().uuid()}).safeParse(req.body);if(!body.success)throw new HttpError(400,"VALIDATION_ERROR","Invalid import ID.");
 const item=imports.get(body.data.importId);
 const quizId=String(req.params.quizId);
 if(!item||item.adminId!==req.auth!.userId||item.quizId!==quizId||item.expires<Date.now())throw new HttpError(400,"IMPORT_EXPIRED","Import preview expired. Upload the file again.");
 if(!item.questions.length)throw new HttpError(400,"NO_VALID_QUESTIONS","No valid questions to import.");
 const quiz=await prisma.quiz.findUnique({where:{id:item.quizId}});if(!quiz||quiz.status!=="DRAFT")throw new HttpError(409,"INVALID_STATE","Questions can only be imported into a draft quiz.");
 const imported=await prisma.$transaction(async tx=>{
  const currentCount=await tx.question.count({where:{quizId:quiz.id}});
  for(let i=0;i<item.questions.length;i++){
   const q=item.questions[i];
   await tx.question.create({data:{quizId:quiz.id,type:"SINGLE_SELECT",text:q.question,topic:q.topic,marks:q.marks,negativeMarks:q.negativeMarks,explanation:q.explanation,difficulty:q.difficulty,position:currentCount+i,options:{create:[q.optionA,q.optionB,q.optionC,q.optionD].map((text,j)=>({text,position:j,isCorrect:"ABCD"[j]===q.correctAnswer}))}}});
  }
  return item.questions.length;
 },{timeout:60000,maxWait:15000});
 imports.delete(body.data.importId);
 res.json({imported});
}));
adminRouter.post("/notifications",asyncHandler(async(req,res)=>{
 const body=z.object({title:z.string().trim().min(2).max(180),body:z.string().trim().min(2).max(4000),audienceType:z.enum(["ALL","STREAM"]),streamCode:z.string().optional()}).safeParse(req.body);
 if(!body.success)throw new HttpError(400,"VALIDATION_ERROR","Invalid notification.");
 let streamId:string|undefined;
 if(body.data.audienceType==="STREAM"){const stream=await prisma.stream.findUnique({where:{code:body.data.streamCode??""}});if(!stream)throw new HttpError(400,"INVALID_STREAM","Unknown stream.");streamId=stream.id;}
 const notification=await prisma.notification.create({data:{title:body.data.title,body:body.data.body,audienceType:body.data.audienceType,streamId}});
 res.status(201).json({id:notification.id});
}));
