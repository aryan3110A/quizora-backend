import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { markShuttingDown } from "./lib/lifecycle";
import { prisma } from "./lib/prisma";
import { closeRedis, connectRedis, redisEnabled } from "./lib/redis";

// Quizora API server
const server=app.listen(env.PORT,()=>{process.stdout.write(`Quizora API listening on ${env.PORT}\n`);});

// An AWS ALB closes idle connections after 60 s by default. Node must keep its side open LONGER than that, otherwise the ALB can
// reuse a connection Node just closed and the client sees a sporadic 502. (headersTimeout must exceed keepAliveTimeout.)
server.keepAliveTimeout=65_000;
server.headersTimeout=66_000;

// Warm the database pool in the background. The first query otherwise pays for starting Prisma's engine and opening the connection
// (about 2 s measured), which would make the very first requests - and health probes - slow. Never fatal: if the database is down
// the process stays up and /health/ready reports 503 until it recovers.
void prisma.$connect().then(()=>logger.info("database pool ready"),err=>logger.warn({err:err instanceof Error?err.message:String(err)},"database not reachable at startup; /health/ready will report 503 until it is"));

// Redis is optional and the API must start without it: connect in the background, never fail startup.
if(redisEnabled()){void connectRedis().then(ready=>logger.info({ready},ready?"redis connected":"redis not reachable yet; continuing (will keep retrying)"));}

let shuttingDown=false;
async function shutdown(signal:string){
 if(shuttingDown)return;
 shuttingDown=true;
 process.stdout.write(`${signal}: shutting down\n`);
 markShuttingDown(); // /health/ready now answers 503 so the load balancer stops sending new requests
 setTimeout(()=>process.exit(1),15_000).unref(); // hard stop if in-flight requests do not finish
 server.close(async()=>{ // resolves once in-flight requests are done; idle keep-alive connections are closed by Node
  await Promise.allSettled([prisma.$disconnect(),closeRedis()]);
  process.exit(0);
 });
 server.closeIdleConnections();
}
process.on("SIGTERM",()=>void shutdown("SIGTERM"));
process.on("SIGINT",()=>void shutdown("SIGINT"));
