import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import type Redis from "ioredis";
import { env } from "./config/env";
import { HttpError } from "./lib/http";
import { getRedis } from "./lib/redis";
import { RedisRateLimitStore } from "./lib/rateLimitStore";
import { authRouter } from "./routes/auth";
import { studentRouter } from "./routes/student";
import { adminRouter } from "./routes/admin";
import { createHealthRouter, defaultHealthDeps, type HealthDeps } from "./routes/health";
import { csrfProtection } from "./middleware/auth";

export type AppOptions = {
  /** Reverse proxies in front of the app (0 none, 1 ALB, 2 CloudFront + ALB). Default: TRUST_PROXY_HOPS. */
  trustProxyHops?: number;
  /** Redis client for shared rate limiting; `null` forces in-process counters. Default: the process-wide client (if configured). */
  redis?: Redis | null;
  /** The /auth limit. Defaults: AUTH_RATE_LIMIT_MAX per AUTH_RATE_LIMIT_WINDOW_MS per client IP (originally 50 / 15 min). */
  authRateLimit?: { windowMs: number; max: number };
  health?: Partial<HealthDeps>;
};

/**
 * Builds one backend "instance". Everything per-instance is created here, so several can run in one process (tests) or one per
 * container (production) with identical behaviour. The exported `app` below is the instance server.ts runs.
 */
export function createApp(options: AppOptions = {}): express.Express {
  const app = express();

  // Reverse proxy. A NUMBER (never `true`): trust exactly that many proxy hops, counted from the app side. Express then takes
  // the client address from the X-Forwarded-For entry added by the outermost TRUSTED proxy, and ignores anything a client put
  // further left in that header — so a client cannot pick its own IP. 0 (default) = no proxy: X-Forwarded-* are ignored.
  app.set("trust proxy", options.trustProxyHops ?? env.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({origin:env.FRONTEND_ORIGIN,credentials:true,allowedHeaders:["Content-Type","x-csrf-token"],exposedHeaders:["x-csrf-token"],methods:["GET","POST","PUT","PATCH","DELETE","OPTIONS"]}));
  app.use(express.json({limit:"1mb"}));
  app.use(cookieParser());
  app.use(pinoHttp({
    level:env.NODE_ENV==="test"?"silent":"info",
    // Load-balancer probes would otherwise write a log line every few seconds per instance.
    autoLogging:{ignore:req=>Boolean(req.url?.startsWith("/health/")||req.url?.startsWith("/api/v1/health/"))},
    redact:["req.headers.cookie","req.headers.authorization","req.body.password"]
  }));

  // Health checks: before CSRF/auth, no cookies, no rate limit. Also under /api/v1 so they are reachable through an `/api/*` rule.
  const health = createHealthRouter({ ...defaultHealthDeps(), ...options.health });
  app.use("/health", health);
  app.use("/api/v1/health", health);
  app.get("/api/v1/health",csrfProtection,(_req,res)=>res.json({status:"ok",timestamp:new Date().toISOString()}));

  // Login/password endpoints: per-client-IP limit, shared across instances through Redis when configured.
  const redis = options.redis === undefined ? getRedis() : options.redis;
  const limit = options.authRateLimit ?? { windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, max: env.AUTH_RATE_LIMIT_MAX };
  const authLimiter = rateLimit({
    windowMs: limit.windowMs,
    limit: limit.max,
    standardHeaders: true,
    legacyHeaders: false,
    store: redis ? new RedisRateLimitStore(redis, `${env.REDIS_KEY_PREFIX}rl:auth:`) : undefined,
    handler: (_req, res) => {
      res.status(429).json({error:{code:"RATE_LIMITED",message:"Too many attempts. Please wait a few minutes and try again."}});
    }
  });
  app.use("/api/v1/auth",authLimiter,authRouter);
  app.use("/api/v1",csrfProtection);
  app.use("/api/v1/student",studentRouter);
  app.use("/api/v1/admin",adminRouter);
  app.use((req,_res,next)=>next(new HttpError(404,"NOT_FOUND",`Route ${req.method} ${req.path} not found.`)));
  app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
   if(err instanceof HttpError)return res.status(err.status).json({error:{code:err.code,message:err.message}});
   const e=err as {status?:number;message?:string;name?:string};
   if(e?.name==="ZodError")return res.status(400).json({error:{code:"VALIDATION_ERROR",message:"Request data is invalid."}});
   if(e?.name==="MulterError")return res.status(e.message==="File too large"?413:400).json({error:{code:"UPLOAD_ERROR",message:"Upload rejected. Check file type and size."}});
   if(e?.name==="PrismaClientKnownRequestError"&&(e as {code?:string}).code==="P2002")return res.status(409).json({error:{code:"CONFLICT",message:"A record with this information already exists."}});
   // Errors raised by Express' body parser carry their own 4xx status. Without this they became 500s, which are client mistakes (and would
   // trip a 5xx alarm on the load balancer): oversized JSON body -> 413, malformed JSON -> 400.
   const http=err as {status?:number;statusCode?:number;type?:string};
   const httpStatus=http.status??http.statusCode;
   if(typeof httpStatus==="number"&&httpStatus>=400&&httpStatus<500){
    if(http.type==="entity.too.large")return res.status(413).json({error:{code:"PAYLOAD_TOO_LARGE",message:"Request body is too large."}});
    if(http.type==="entity.parse.failed")return res.status(400).json({error:{code:"INVALID_JSON",message:"Request body is not valid JSON."}});
    return res.status(httpStatus).json({error:{code:"BAD_REQUEST",message:"The request could not be processed."}});
   }
   res.status(500).json({error:{code:"INTERNAL_ERROR",message:env.NODE_ENV==="production"?"An unexpected error occurred.":(e?.message??"Unknown error")}});
  });
  return app;
}

export const app = createApp();
