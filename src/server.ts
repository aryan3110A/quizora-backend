import { app } from "./app";
import { env } from "./config/env";
import { prisma } from "./lib/prisma";

// Quizora API server
const server=app.listen(env.PORT,()=>{process.stdout.write(`Quizora API listening on ${env.PORT}\n`);});
async function shutdown(signal:string){
 process.stdout.write(`${signal}: shutting down\n`);
 server.close(async()=>{await prisma.$disconnect();process.exit(0);});
 setTimeout(()=>process.exit(1),10_000).unref();
}
process.on("SIGTERM",()=>void shutdown("SIGTERM"));
process.on("SIGINT",()=>void shutdown("SIGINT"));
