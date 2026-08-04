import { z } from "zod";

// 环境变量校验，参考 Langfuse packages/shared/src/env.ts
export const envSchema = z.object({
  DATABASE_URL: z.string(),
  PG_PORT: z.coerce.number().default(5433),
  PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default("./.machora-data"),
  NODE_ENV: z.string().default("development"),

  // Seed
  MACHORA_INIT_PROJECT_NAME: z.string().default("Machora Project"),
  MACHORA_INIT_PROJECT_PUBLIC_KEY: z.string(),
  MACHORA_INIT_PROJECT_SECRET_KEY: z.string(),
  MACHORA_INIT_USER_EMAIL: z.string().default("admin@machora.local"),
  // 不设默认值：standalone 从 .env 读取；未配置时 seed 随机生成并打印
  MACHORA_INIT_USER_PASSWORD: z.string().optional(),
  MACHORA_INIT_USER_NAME: z.string().default("Admin"),

  NEXTAUTH_URL: z.string().default("http://localhost:3100"),
  NEXTAUTH_SECRET: z.string(),
});

export type Env = z.infer<typeof envSchema>;

// 懒加载校验：standalone setupEnvironment 注入完 env 后再调用
let _env: Env | null = null;
export function getEnv(): Env {
  if (!_env) {
    _env = envSchema.parse(process.env);
  }
  return _env;
}
