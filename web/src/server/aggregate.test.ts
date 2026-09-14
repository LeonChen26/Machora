/**
 * 聚合模块在「分批扫描 + 增量聚合」改造后的行为回归（真实 SQLite，不 mock）。
 * 目的是锁住改造前的口径：窗口切分、Agent 归属、trace 数去重、成功率、每日桶。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { db, getSqliteHandle, observation, trace } from "@machora/shared";
import { getOverview } from "./overview";
import { getAgentDirectory } from "./agentStats";

let tmp: string;

const DAY = 24 * 60 * 60 * 1000;
const today = new Date();
today.setHours(0, 0, 0, 0);
// 与各模块 windowBounds 一致：days=7 的 since 与前一窗口边界
const since = new Date(today.getTime() - 6 * DAY);
const cur1 = new Date(since.getTime() + 3 * 3600 * 1000);
const cur2 = new Date(since.getTime() + 4 * 3600 * 1000);
const prev1 = new Date(since.getTime() - 2 * 3600 * 1000);

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "machora-agg-"));
  process.env.DATA_DIR = tmp;

  const schemaPath = resolve(
    import.meta.dirname,
    "../../../packages/shared/sql/schema.sql",
  );
  getSqliteHandle().exec(readFileSync(schemaPath, "utf8"));

  await db.insert(trace).values([
    { id: "T1", name: "t1", timestamp: cur1, agentName: "a1", tags: [] },
    { id: "T2", name: "t2", timestamp: cur2, tags: [] },
    { id: "T3", name: "t3", timestamp: prev1, agentName: "a1", tags: [] },
  ]);
  await db.insert(observation).values([
    {
      id: "O1",
      traceId: "T1",
      type: "LLM",
      startTime: cur1,
      endTime: new Date(cur1.getTime() + 100),
      model: "m1",
      level: "DEFAULT",
      totalCost: 0.02,
      totalTokens: 100,
    },
    {
      id: "O2",
      traceId: "T1",
      type: "TOOL",
      startTime: new Date(cur1.getTime() + 1000),
      endTime: new Date(cur1.getTime() + 1005),
      level: "ERROR",
    },
    {
      id: "O3",
      traceId: "T2",
      type: "LLM",
      agentName: "a2",
      startTime: cur2,
      endTime: new Date(cur2.getTime() + 200),
      model: "m2",
      level: "DEFAULT",
      totalCost: 0.01,
      totalTokens: 50,
    },
    {
      id: "O4",
      traceId: "T3",
      type: "LLM",
      startTime: prev1,
      endTime: new Date(prev1.getTime() + 300),
      model: "m1",
      level: "DEFAULT",
      totalCost: 0.5,
      totalTokens: 10,
    },
  ]);
});

afterAll(() => {
  try {
    getSqliteHandle().close();
  } catch {
    /* 已关闭 */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("getOverview（分批扫描后口径不变）", () => {
  it("全局 KPI 只统计当前窗口", async () => {
    const o = await getOverview(7);
    expect(o.totals.traces).toBe(2); // T1 / T2（T3 属前一窗口）
    expect(o.totals.calls).toBe(2); // O1 / O3（LLM）
    expect(o.totals.cost).toBeCloseTo(0.03);
    expect(o.totals.errorRate).toBeCloseTo(1 / 3); // 3 steps, 1 ERROR
  });

  it("Agent 归属：trace.agentName 优先，span 兜底", async () => {
    const o = await getOverview(7);
    const a1 = o.agents.find((a) => a.name === "a1");
    const a2 = o.agents.find((a) => a.name === "a2");
    expect(a1?.traces).toBe(1);
    expect(a1?.calls).toBe(1);
    expect(a2?.traces).toBe(1); // T2 无 trace.agentName，归到 span 的 a2
    expect(a2?.calls).toBe(1);
  });

  it("每日 trace 桶合计等于当前窗口 trace 数", async () => {
    const o = await getOverview(7);
    expect(o.daily.reduce((s, d) => s + d.traces, 0)).toBe(2);
  });
});

describe("getAgentDirectory（增量聚合口径不变）", () => {
  it("trace 数 / 成功率 / 合计去重正确", async () => {
    const dir = await getAgentDirectory(7);
    expect(dir.agents.map((a) => a.name).sort()).toEqual(["a1", "a2"]);

    const a1 = dir.agents.find((a) => a.name === "a1")!;
    expect(a1.traces).toBe(1);
    expect(a1.successRate).toBeCloseTo(0); // T1 含 ERROR 步骤

    const a2 = dir.agents.find((a) => a.name === "a2")!;
    expect(a2.traces).toBe(1);
    expect(a2.successRate).toBeCloseTo(1); // T2 无错误

    expect(dir.totals.traces).toBe(2); // 跨桶按 traceId 去重
  });
});
