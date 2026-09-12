import { z } from "zod";

// 环境变量校验，参考 Langfuse packages/shared/src/env.ts
export const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATA_DIR: z.string().default("./.machora-data"),
  NODE_ENV: z.string().default("development"),
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
