/**
 * getTraceFilterStats 聚合下推的等价性测试（真实 SQLite 文件，不 mock）。
 *
 * 校验下推后与原先「全量拉行 + JS 聚合」口径一致：
 * steps / errors / cost 标量，以及 P95 = 时长升序第 floor(n*0.95) 条。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { db, getSqliteHandle, observation, trace } from "@machora/shared";
import { getTraceFilterStats, type TraceFilters } from "./traceQuery";

let tmp: string;

const FROM = new Date("2026-05-01T00:00:00.000Z");
const TO = new Date("2026-05-02T00:00:00.000Z");
const BASE = new Date("2026-05-01T08:00:00.000Z");
const DURS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "machora-tq-"));
  process.env.DATA_DIR = tmp;

  const schemaPath = resolve(
    import.meta.dirname,
    "../../../packages/shared/sql/schema.sql",
  );
  getSqliteHandle().exec(readFileSync(schemaPath, "utf8"));

  await db.insert(trace).values([
    { id: "t1", name: "in-window", timestamp: BASE, tags: [] },
    {
      id: "t2",
      name: "out-window",
      timestamp: new Date("2026-04-01T00:00:00.000Z"),
      tags: [],
    },
  ]);

  // 10 条有 endTime 的步骤（时长 DURS），首条为 ERROR，各计 $0.5
  await db.insert(observation).values(
    DURS.map((d, i) => ({
      id: `o${i}`,
      traceId: "t1",
      type: "LLM",
      startTime: new Date(BASE.getTime() + i * 1000),
      endTime: new Date(BASE.getTime() + i * 1000 + d),
      level: i === 0 ? "ERROR" : "DEFAULT",
      totalCost: 0.5,
    })),
  );
  // 无 endTime 的步骤：计入 steps，不计入 P95
  await db.insert(observation).values({
    id: "o-noend",
    traceId: "t1",
    type: "STEP",
    startTime: BASE,
    level: "DEFAULT",
  });
  // 窗口外 trace 的步骤：不应计入
  await db.insert(observation).values({
    id: "o-out",
    traceId: "t2",
    type: "LLM",
    startTime: new Date("2026-04-01T00:00:00.000Z"),
    endTime: new Date("2026-04-01T00:00:01.000Z"),
  });
});

afterAll(() => {
  try {
    getSqliteHandle().close();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

const inWindow: TraceFilters = { from: FROM, to: TO, tags: [] };

describe("getTraceFilterStats（SQL 下推）", () => {
  it("steps / errors / cost 与时间窗过滤一致", async () => {
    const st = await getTraceFilterStats(inWindow);
    expect(st.steps).toBe(11); // 10 条 + 1 条无 endTime（窗口外那条不计）
    expect(st.errors).toBe(1);
    expect(st.errorRate).toBeCloseTo(1 / 11);
    expect(st.cost).toBeCloseTo(5.0);
  });

  it("P95 取时长升序第 floor(n*0.95) 条（与 JS p95of 口径一致）", async () => {
    const st = await getTraceFilterStats(inWindow);
    const expected =
      DURS[Math.min(DURS.length - 1, Math.floor(DURS.length * 0.95))];
    expect(st.p95).toBe(expected); // DURS 升序 → 100
  });

  it("无匹配时返回全 0 且 p95 为 null", async () => {
    const st = await getTraceFilterStats({
      from: new Date("2030-01-01T00:00:00.000Z"),
      to: new Date("2030-01-02T00:00:00.000Z"),
      tags: [],
    });
    expect(st).toEqual({ steps: 0, errors: 0, errorRate: 0, cost: 0, p95: null });
  });

  it("标签过滤仍然生效（hasTags 方言层）", async () => {
    const st = await getTraceFilterStats({ ...inWindow, tags: ["nope"] });
    expect(st.steps).toBe(0);
  });
});
