"use client";

// Prompt 级数据集管理（client）：新建用例 / 查看数据集 / 删除 / 对整个数据集批量评测（LLM judge）
// 与 tag 数据集不同：用例是独立定义（input/expectedOutput），不依赖 trace
import { useEffect, useTransition, useState } from "react";
import { BarChart } from "../../components/BarChart";

export interface DatasetConfig {
  id: string;
  name: string;
  evaluatorType: string;
}

interface DatasetItemRow {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  expectedOutput: unknown;
  createdAt: string;
}

interface DatasetStat {
  configName: string;
  n: number;
  avg: number;
  passRate: number | null;
  dataType: string;
}

interface DatasetGroup {
  name: string;
  count: number;
  items: DatasetItemRow[];
  stats: DatasetStat[];
}

/** JSON 摘要（折行 + 截断） */
function summarize(v: unknown, maxLen = 120): string {
  if (v === null || v === undefined) return "—";
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function DatasetManager({ configs }: { configs: DatasetConfig[] }) {
  const [groups, setGroups] = useState<DatasetGroup[]>([]);
  const [loaded, setLoaded] = useState(false);

  // 新建用例表单
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [expectedOutput, setExpectedOutput] = useState("");

  // 评测：勾选多个 LLM 配置 → 对该数据集并发批量评测（对比不同配置/模型）
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(configs.filter((c) => c.evaluatorType === "llm").map((c) => [c.id, false])),
  );
  const [evalFor, setEvalFor] = useState<string | null>(null); // 正在评测的数据集名

  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    const res = await fetch("/api/datasets", { cache: "no-store" });
    const data = await res.json();
    setGroups((data.datasets as DatasetGroup[]) ?? []);
    setLoaded(true);
  }

  useEffect(() => {
    void load();
  }, []);

  function addItem() {
    if (!name.trim()) {
      setMsg({ ok: false, text: "数据集名必填" });
      return;
    }
    let inputJson: unknown;
    let expectedJson: unknown;
    try {
      inputJson = input.trim() ? JSON.parse(input) : null;
      expectedJson = expectedOutput.trim() ? JSON.parse(expectedOutput) : null;
    } catch {
      setMsg({ ok: false, text: "input / expectedOutput 需为合法 JSON" });
      return;
    }
    setMsg(null);
    startTransition(async () => {
      const res = await fetch("/api/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), input: inputJson, expectedOutput: expectedJson }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ ok: true, text: `已添加用例到「${name.trim()}」` });
        setName("");
        setInput("");
        setExpectedOutput("");
        await load();
      } else {
        setMsg({ ok: false, text: data.error ?? "添加失败" });
      }
    });
  }

  function deleteItem(id: string) {
    startTransition(async () => {
      await fetch(`/api/datasets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    });
  }

  function deleteDataset(name: string) {
    if (!window.confirm(`删除数据集「${name}」及全部用例？`)) return;
    startTransition(async () => {
      await fetch(`/api/datasets?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      await load();
    });
  }

  function runEval(groupName: string) {
    const selected = llmConfigs.filter((c) => checked[c.id]);
    if (selected.length === 0) {
      setMsg({ ok: false, text: "请先勾选至少一个 LLM judge 配置" });
      return;
    }
    setEvalFor(groupName);
    setMsg(null);
    startTransition(async () => {
      // 对每个勾选配置分别触发数据集批量评测，便于对比
      const results: string[] = [];
      for (const cfg of selected) {
        const res = await fetch("/api/evaluations/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ configId: cfg.id, datasetId: groupName }),
        });
        const data = await res.json();
        if (res.ok) {
          results.push(`${cfg.name}×${data.count}`);
        } else {
          results.push(`${cfg.name}✗(${data.error ?? res.status})`);
        }
      }
      setEvalFor(null);
      setMsg({
        ok: true,
        text: `数据集「${groupName}」评测完成触发：${results.join("、")}。稍后刷新查看对比。`,
      });
      await load();
    });
  }

  const llmConfigs = configs.filter((c) => c.evaluatorType === "llm");

  return (
    <div className="card mb-3">
      <div className="form-title">Prompt 级数据集（LLM judge 评测）</div>

      {/* 新建用例 */}
      <div className="form-row" style={{ alignItems: "flex-start" }}>
        <label className="field">
          <span className="field-label">数据集名</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
            placeholder="如：helpfulness / 客服质检"
          />
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span className="field-label">输入（JSON）</span>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="input"
            rows={2}
            placeholder='{"question": "退货流程是什么？"}'
          />
        </label>
        <label className="field" style={{ flex: 2 }}>
          <span className="field-label">期望输出（JSON，可选）</span>
          <textarea
            value={expectedOutput}
            onChange={(e) => setExpectedOutput(e.target.value)}
            className="input"
            rows={2}
            placeholder='{"answer": "..."}'
          />
        </label>
        <button
          type="button"
          className="btn primary"
          onClick={addItem}
          disabled={pending}
          aria-busy={pending}
          style={{ alignSelf: "flex-end" }}
        >
          {pending && <span className="spinner" aria-hidden="true" />}
          添加用例
        </button>
      </div>

      {msg && (
        <div
          className={`form-${msg.ok ? "success" : "error"} text-sm`}
          role={msg.ok ? "status" : "alert"}
        >
          {msg.text}
        </div>
      )}

      {loaded && groups.length === 0 && (
        <div className="text-sm muted" style={{ marginTop: 12 }}>
          暂无数据集。在上方定义用例（如：给一条用户问题打分），再选 LLM judge 配置对整个数据集评测。
        </div>
      )}

      {groups.map((g) => (
        <div className="card mt-2" key={g.name} style={{ border: "1px dashed var(--border)" }}>
          <div className="flex-between" style={{ flexWrap: "wrap", gap: 8 }}>
            <div className="label" style={{ margin: 0 }}>
              {g.name} <span className="count">{g.count} 条用例</span>
            </div>
            <div className="form-inline" style={{ flexWrap: "wrap" }}>
              {llmConfigs.length === 0 ? (
                <span className="text-xs muted">先创建 LLM judge 配置</span>
              ) : (
                llmConfigs.map((c) => (
                  <label
                    key={c.id}
                    className="form-inline"
                    style={{ alignItems: "center", gap: 4, fontSize: 12 }}
                  >
                    <input
                      type="checkbox"
                      checked={!!checked[c.id]}
                      onChange={(e) =>
                        setChecked({ ...checked, [c.id]: e.target.checked })
                      }
                      style={{ width: 14, height: 14 }}
                    />
                    {c.name}
                  </label>
                ))
              )}
              <button
                type="button"
                className="btn primary"
                onClick={() => runEval(g.name)}
                disabled={pending || llmConfigs.length === 0 || evalFor === g.name}
                aria-busy={evalFor === g.name}
              >
                {evalFor === g.name && <span className="spinner" aria-hidden="true" />}
                {evalFor === g.name ? "评测中…" : "对比评测"}
              </button>
              <button type="button" className="btn danger" onClick={() => deleteDataset(g.name)}>
                删除
              </button>
            </div>
          </div>

          {g.stats.length > 0 && (
            <div className="mt-2">
              <div className="text-xs muted" style={{ marginBottom: 6 }}>
                评测对比（按配置）
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 10,
                }}
              >
                {g.stats.map((s) => (
                  <div
                    key={s.configName}
                    className="card"
                    style={{ padding: "8px 10px", border: "1px dashed var(--border)" }}
                  >
                    <div className="text-xs" style={{ fontWeight: 600 }}>
                      {s.configName}
                    </div>
                    <div className="text-sm">
                      {s.dataType === "BOOLEAN"
                        ? `通过率 ${Math.round((s.passRate ?? 0) * 100)}%`
                        : `平均分 ${s.avg}`}
                      <span className="muted"> · {s.n} 次</span>
                    </div>
                  </div>
                ))}
              </div>
              <BarChart
                data={g.stats.map((s) => ({ label: s.configName, value: s.avg }))}
                height={90}
                emptyText="暂无评测结果"
              />
            </div>
          )}

          <div className="table-wrap mt-2">
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: 90 }}>#</th>
                  <th scope="col">输入</th>
                  <th scope="col">期望输出</th>
                  <th scope="col" style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((it, i) => (
                  <tr key={it.id}>
                    <td className="mono muted text-xs">{i + 1}</td>
                    <td className="text-xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {summarize(it.input)}
                    </td>
                    <td className="text-xs" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {summarize(it.expectedOutput)}
                    </td>
                    <td>
                      <button type="button" className="btn sm danger" onClick={() => deleteItem(it.id)}>
                        删
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
