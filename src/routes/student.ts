import { Router } from "express";
import { AttemptStatus, QuizStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, HttpError } from "../lib/http";
import { requireAuth } from "../middleware/auth";

export const studentRouter=Router();
studentRouter.use(requireAuth);
function now(){return new Date();}
function isReleased(quizEndsAt:Date, finalizedAt:Date|null){return now()>=quizEndsAt && !!finalizedAt;}
studentRouter.get("/dashboard",asyncHandler(async(req,res)=>{
 const user=await prisma.user.findUnique({where:{id:req.auth!.userId},include:{stream:true}});
 if(!user)throw new HttpError(404,"USER_NOT_FOUND","User not found.");
 const current=now();
 const quizzes=await prisma.quiz.findMany({where:{status:QuizStatus.PUBLISHED,streams:{some:{streamId:user.streamId??"00000000-0000-0000-0000-000000000000"}}},orderBy:{startsAt:"asc"},include:{attempts:{where:{userId:user.id},select:{id:true,status:true,score:true,totalMarks:true,finalizedAt:true,submittedAt:true}}}});
 const eligible=quizzes.filter(q=>q.attempts.length===0);
 const active=eligible.filter(q=>q.startsAt<=current&&q.endsAt>current);
 const upcoming=eligible.filter(q=>q.startsAt>current);
 const completedAttempts=quizzes.flatMap(q=>q.attempts.filter(a=>a.status===AttemptStatus.SUBMITTED||a.finalizedAt!==null));
 const released=quizzes.flatMap(q=>q.attempts.filter(a=>isReleased(q.endsAt,a.finalizedAt)&&a.score!==null&&a.totalMarks!==null).map(a=>({score:a.score!,totalMarks:a.totalMarks!,submittedAt:a.submittedAt??a.finalizedAt??current,title:q.title})));
 const percentages=released.map(a=>a.totalMarks>0?a.score/a.totalMarks*100:0);
 const completedList=quizzes.flatMap(q=>q.attempts.filter(a=>a.status===AttemptStatus.SUBMITTED||a.finalizedAt!==null).map(a=>{
  const isRel=isReleased(q.endsAt,a.finalizedAt);
  return {
   attemptId:a.id,
   quizId:q.id,
   title:q.title,
   endsAt:q.endsAt,
   submittedAt:a.submittedAt??a.finalizedAt??current,
   isReleased:isRel,
   score:isRel?a.score:null,
   totalMarks:isRel?a.totalMarks:null,
   percentage:isRel&&a.totalMarks?Math.round((a.score!/a.totalMarks)*1000)/10:null
  };
 }));
 const notifications=await prisma.notification.findMany({where:{OR:[{audienceType:"ALL"},{audienceType:"STREAM",streamId:user.streamId}]},orderBy:{publishedAt:"desc"},take:5});
 res.json({user:{fullName:user.fullName,studentId:user.studentId,stream:user.stream?.name??"Unassigned",role:user.role,mustChangePassword:user.mustChangePassword},stats:{attempted:completedAttempts.length,averageScore:percentages.length?Math.round(percentages.reduce((a,b)=>a+b,0)/percentages.length*10)/10:null,upcomingCount:upcoming.length,latestScore:percentages.length?Math.round(percentages[percentages.length-1]*10)/10:null},active:active.map(q=>({id:q.id,title:q.title,startsAt:q.startsAt,endsAt:q.endsAt,durationMinutes:q.durationMinutes})),upcoming:upcoming.slice(0,8).map(q=>({id:q.id,title:q.title,startsAt:q.startsAt,endsAt:q.endsAt,durationMinutes:q.durationMinutes})),completed:completedList,notifications});
}));
studentRouter.get("/quizzes/upcoming",asyncHandler(async(req,res)=>{
 const quizzes=await prisma.quiz.findMany({where:{status:"PUBLISHED",startsAt:{gt:now()},streams:{some:{streamId:req.auth!.streamId??""}}},orderBy:{startsAt:"asc"},select:{id:true,title:true,description:true,startsAt:true,endsAt:true,durationMinutes:true}});
 res.json({quizzes});
}));
studentRouter.get("/quizzes/available",asyncHandler(async(req,res)=>{
 const quizzes=await prisma.quiz.findMany({where:{status:"PUBLISHED",startsAt:{lte:now()},endsAt:{gt:now()},streams:{some:{streamId:req.auth!.streamId??""}},attempts:{none:{userId:req.auth!.userId}}},select:{id:true,title:true,description:true,startsAt:true,endsAt:true,durationMinutes:true}});
 res.json({quizzes});
}));
studentRouter.post("/quizzes/:quizId/attempts",asyncHandler(async(req,res)=>{
 const quizId=String(req.params.quizId);
 const quiz=await prisma.quiz.findUnique({where:{id:quizId},include:{streams:true,questions:{include:{options:{orderBy:{position:"asc"}}},orderBy:{position:"asc"}}}});
 if(!quiz||quiz.status!=="PUBLISHED")throw new HttpError(404,"QUIZ_NOT_FOUND","Quiz not found.");
 if(!quiz.streams.some(s=>s.streamId===req.auth!.streamId))throw new HttpError(403,"FORBIDDEN","This quiz is not assigned to your stream.");
 const current=now();
 if(current<quiz.startsAt||current>=quiz.endsAt)throw new HttpError(403,"QUIZ_NOT_AVAILABLE","This quiz is not currently available.");
 if(!quiz.questions.length)throw new HttpError(409,"QUIZ_EMPTY","This quiz has no questions.");
 const deadlineAt=new Date(Math.min(current.getTime()+quiz.durationMinutes*60_000,quiz.endsAt.getTime()));
 let attempt=await prisma.attempt.findUnique({where:{quizId_userId:{quizId:quiz.id,userId:req.auth!.userId}},include:{answers:true,questions:{include:{question:{include:{options:true}}},orderBy:{displayOrder:"asc"}}}});
 if(!attempt){
  try{
   attempt=await prisma.attempt.create({data:{quizId:quiz.id,userId:req.auth!.userId,startedAt:current,deadlineAt,questions:{create:quiz.questions.map((q,i)=>({questionId:q.id,displayOrder:i,optionOrderSnapshot:q.options.map(o=>o.id)}))}},include:{answers:true,questions:{include:{question:{include:{options:true}}},orderBy:{displayOrder:"asc"}}}});
  }catch(err:any){
   if(err?.code==="P2002"){
    attempt=await prisma.attempt.findUniqueOrThrow({where:{quizId_userId:{quizId:quiz.id,userId:req.auth!.userId}},include:{answers:true,questions:{include:{question:{include:{options:true}}},orderBy:{displayOrder:"asc"}}}});
   }else throw err;
  }
 }
 if(attempt.status!=="IN_PROGRESS")throw new HttpError(409,"ATTEMPT_FINALIZED","This attempt has already been submitted.");
 if(current>=attempt.deadlineAt)throw new HttpError(409,"ATTEMPT_EXPIRED","The deadline has passed.");
 const answers=Object.fromEntries(attempt.answers.map(a=>[a.questionId,a.selectedOptionId]));
 res.json({id:attempt.id,title:quiz.title,deadlineAt:attempt.deadlineAt,answers,questions:attempt.questions.map(a=>({id:a.questionId,text:a.question.text,type:a.question.type,position:a.displayOrder,marks:a.question.marks,options:(a.optionOrderSnapshot as string[]).map(id=>a.question.options.find(o=>o.id===id)).filter(Boolean).map(o=>({id:o!.id,text:o!.text,position:o!.position}))}))});
}));
studentRouter.get("/attempts/:attemptId",asyncHandler(async(req,res)=>{
 const attemptId=String(req.params.attemptId);
 const attempt=await prisma.attempt.findFirst({where:{id:attemptId,userId:req.auth!.userId},include:{quiz:true,answers:true,questions:{include:{question:{include:{options:true}}},orderBy:{displayOrder:"asc"}}}});
 if(!attempt)throw new HttpError(404,"ATTEMPT_NOT_FOUND","Attempt not found.");
 if(attempt.status!=="IN_PROGRESS")throw new HttpError(409,"ATTEMPT_FINALIZED","This attempt is no longer active.");
 if(now()>=attempt.deadlineAt)throw new HttpError(409,"ATTEMPT_EXPIRED","The deadline has passed.");
 res.json({id:attempt.id,title:attempt.quiz.title,deadlineAt:attempt.deadlineAt,answers:Object.fromEntries(attempt.answers.map(a=>[a.questionId,a.selectedOptionId])),questions:attempt.questions.map(a=>({id:a.questionId,text:a.question.text,type:a.question.type,position:a.displayOrder,marks:a.question.marks,options:(a.optionOrderSnapshot as string[]).map(id=>a.question.options.find(o=>o.id===id)).filter(Boolean).map(o=>({id:o!.id,text:o!.text,position:o!.position}))}))});
}));
studentRouter.put("/attempts/:attemptId/answers/:questionId",asyncHandler(async(req,res)=>{
 const body=z.object({selectedOptionId:z.string().uuid().nullable().optional()}).safeParse(req.body);
 if(!body.success)throw new HttpError(400,"VALIDATION_ERROR","Invalid answer payload.");
 const attemptId=String(req.params.attemptId);
 const questionId=String(req.params.questionId);
 const attempt=await prisma.attempt.findFirst({where:{id:attemptId,userId:req.auth!.userId},include:{quiz:true}});
 if(!attempt)throw new HttpError(404,"ATTEMPT_NOT_FOUND","Attempt not found.");
 if(attempt.status!=="IN_PROGRESS"||now()>=attempt.deadlineAt||now()>=attempt.quiz.endsAt)throw new HttpError(409,"ATTEMPT_CLOSED","This attempt is closed.");
 const question=await prisma.question.findFirst({where:{id:questionId,quizId:attempt.quizId},include:{options:true}});
 if(!question)throw new HttpError(404,"QUESTION_NOT_FOUND","Question not found.");
 const optionId=body.data.selectedOptionId??null;
 if(optionId&&!question.options.some(o=>o.id===optionId))throw new HttpError(400,"INVALID_OPTION","Selected option does not belong to this question.");
 await prisma.attemptAnswer.upsert({where:{attemptId_questionId:{attemptId:attempt.id,questionId:question.id}},create:{attemptId:attempt.id,questionId:question.id,selectedOptionId:optionId},update:{selectedOptionId:optionId}});
 res.json({ok:true,attemptId:attempt.id,questionId:question.id,savedAt:now().toISOString()});
}));
async function finalizeAttempt(attemptId:string,userId:string){
 return prisma.$transaction(async tx=>{
  const a=await tx.attempt.findFirst({where:{id:attemptId,userId},include:{quiz:{include:{questions:{include:{options:true}}}},answers:true}});
  if(!a)throw new HttpError(404,"ATTEMPT_NOT_FOUND","Attempt not found.");
  if(a.finalizedAt)return a;
  const current=now();
  if(a.status==="IN_PROGRESS"&&current<a.deadlineAt&&current<a.quiz.endsAt)throw new HttpError(409,"QUIZ_NOT_CLOSED","The quiz attempt is still active.");
  let score=0,total=0;
  for(const q of a.quiz.questions){total+=q.marks;const answer=a.answers.find(x=>x.questionId===q.id);const selected=answer?.selectedOptionId;const correct=q.options.find(o=>o.isCorrect);if(selected&&correct&&selected===correct.id)score+=q.marks;else if(selected)score-=q.negativeMarks;}
  const finalScore=Math.max(0,score);
  return tx.attempt.update({where:{id:a.id},data:{score:finalScore,totalMarks:total,status:a.status==="IN_PROGRESS"?"EXPIRED":"FINALIZED",submittedAt:a.submittedAt??current,finalizedAt:current}});
 });
}
studentRouter.post("/attempts/:attemptId/submit",asyncHandler(async(req,res)=>{
 const attemptId=String(req.params.attemptId);
 const attempt=await prisma.attempt.findFirst({where:{id:attemptId,userId:req.auth!.userId},include:{quiz:true}});
 if(!attempt)throw new HttpError(404,"ATTEMPT_NOT_FOUND","Attempt not found.");
 if(attempt.finalizedAt){res.json({ok:true,finalized:true});return;}
 const current=now();
 if(attempt.status!=="IN_PROGRESS")throw new HttpError(409,"ATTEMPT_CLOSED","Attempt is already closed.");
 if(current<attempt.deadlineAt&&current<attempt.quiz.endsAt){
  const result=await prisma.$transaction(async tx=>{
   const a=await tx.attempt.findUniqueOrThrow({where:{id:attempt.id},include:{quiz:{include:{questions:{include:{options:true}}}},answers:true}});
   let score=0,total=0;
   for(const q of a.quiz.questions){total+=q.marks;const answer=a.answers.find(x=>x.questionId===q.id);const correct=q.options.find(o=>o.isCorrect);if(answer?.selectedOptionId&&correct&&answer.selectedOptionId===correct.id)score+=q.marks;else if(answer?.selectedOptionId)score-=q.negativeMarks;}
   return tx.attempt.update({where:{id:a.id},data:{status:"SUBMITTED",submittedAt:current,finalizedAt:current,score:Math.max(0,score),totalMarks:total}});
  });
  res.json({ok:true,finalized:true,score:result.score});return;
 }
 const result=await finalizeAttempt(attempt.id,req.auth!.userId);
 res.json({ok:true,finalized:!!result.finalizedAt});
}));
studentRouter.get("/attempts/:attemptId/result",asyncHandler(async(req,res)=>{
 const attemptId=String(req.params.attemptId);
 const attempt=await prisma.attempt.findFirst({where:{id:attemptId,userId:req.auth!.userId},include:{quiz:{include:{questions:{include:{options:true},orderBy:{position:"asc"}}}},answers:true}});
 if(!attempt)throw new HttpError(404,"ATTEMPT_NOT_FOUND","Attempt not found.");
 if(now()<attempt.quiz.endsAt||!attempt.finalizedAt||attempt.score===null||attempt.totalMarks===null){res.json({released:false});return;}
 res.json({released:true,title:attempt.quiz.title,score:attempt.score,totalMarks:attempt.totalMarks,percentage:attempt.totalMarks>0?Math.round(attempt.score/attempt.totalMarks*1000)/10:0,questions:attempt.quiz.questions.map(q=>{const a=attempt.answers.find(x=>x.questionId===q.id);const selected=q.options.find(o=>o.id===a?.selectedOptionId);const correct=q.options.find(o=>o.isCorrect);return {text:q.text,selectedAnswer:selected?.text??null,correctAnswer:correct?.text??"Not configured",explanation:q.explanation??"",isCorrect:!!selected&&selected.id===correct?.id};})});
}));
studentRouter.get("/performance",asyncHandler(async(req,res)=>{
 const attempts=await prisma.attempt.findMany({where:{userId:req.auth!.userId,finalizedAt:{not:null},score:{not:null},quiz:{endsAt:{lte:now()}}},include:{quiz:true},orderBy:{submittedAt:"desc"}});
 const results=attempts.filter(a=>a.score!==null&&a.totalMarks!==null).map(a=>({quizTitle:a.quiz.title,score:a.score!,totalMarks:a.totalMarks!,percentage:a.totalMarks!>0?Math.round(a.score!/a.totalMarks!*1000)/10:0,submittedAt:(a.submittedAt??a.finalizedAt!).toISOString()}));
 res.json({totalAttempts:results.length,averageScore:results.length?Math.round(results.reduce((s,a)=>s+a.percentage,0)/results.length*10)/10:null,results});
}));
studentRouter.get("/notifications",asyncHandler(async(req,res)=>{
 const notifications=await prisma.notification.findMany({where:{OR:[{audienceType:"ALL"},{audienceType:"STREAM",streamId:req.auth!.streamId??""}]},orderBy:{publishedAt:"desc"},take:50,include:{reads:{where:{userId:req.auth!.userId}}}});
 res.json({notifications:notifications.map(n=>({id:n.id,title:n.title,body:n.body,publishedAt:n.publishedAt,read:n.reads.length>0}))});
}));
