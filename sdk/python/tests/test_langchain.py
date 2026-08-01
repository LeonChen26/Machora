"""LangChain 回调映射逻辑测试（直接调用回调方法模拟 run 事件）。"""

import json
import unittest

import httpx

from machora import MachoraClient

try:
    from machora.langchain import MachoraCallbackHandler

    HAS_LC = True
except ImportError:
    HAS_LC = False


class FakeClient(MachoraClient):
    def __init__(self):
        super().__init__(
            public_key="pk-test",
            secret_key="sk-test",
            host="http://test.local",
        )
        self.captured: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.captured.append(json.loads(request.content))
            return httpx.Response(200, json={"success": True, "received": 1})

        self._http = httpx.Client(transport=httpx.MockTransport(handler))


class _Gen:
    def __init__(self, text: str = "out"):
        self.text = text


class _LLMResult:
    def __init__(self, usage: dict | None = None):
        self.generations = [[_Gen("out")]]
        self.llm_output = (
            {"token_usage": usage} if usage else None
        )


@unittest.skipUnless(HAS_LC, "langchain-core 未安装")
class TestLangchainHandler(unittest.TestCase):
    def test_chain_maps_to_trace(self):
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="my-chain")
        h.on_chain_start({}, {"q": 1}, run_id="r1", parent_run_id=None)
        h.on_chain_end({"a": 2}, run_id="r1")
        batch = c.captured[0]["batch"]
        types = [e["type"] for e in batch]
        self.assertEqual(types, ["trace-create"])
        self.assertEqual(batch[0]["body"]["name"], "my-chain")

    def test_llm_maps_to_generation_with_usage(self):
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="t")
        h.on_chain_start({}, {}, run_id="r1", parent_run_id=None)
        h.on_llm_start({"name": "llm"}, ["prompt"], run_id="r2", parent_run_id="r1")
        h.on_llm_end(
            _LLMResult({"prompt_tokens": 3, "completion_tokens": 2}),
            run_id="r2",
        )
        h.on_chain_end({}, run_id="r1")
        batch = c.captured[0]["batch"]
        obs = [e for e in batch if e["type"] == "observation-create"]
        self.assertEqual(len(obs), 1)
        body = obs[0]["body"]
        self.assertEqual(body["type"], "GENERATION")
        self.assertEqual(body["name"], "llm")
        self.assertEqual(body["usage"], {"prompt_tokens": 3, "completion_tokens": 2})
        self.assertIsNotNone(body["endTime"])

    def test_chat_model_maps_to_generation(self):
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="t")
        h.on_chain_start({}, {}, run_id="r1", parent_run_id=None)

        class Msg:
            def __init__(self, content: str):
                self.content = content

        h.on_chat_model_start(
            {"name": "chat", "kwargs": {"model_name": "gpt-4o"}},
            [[Msg("hello")]],
            run_id="r2",
            parent_run_id="r1",
        )
        h.on_llm_end(_LLMResult(), run_id="r2")
        h.on_chain_end({}, run_id="r1")
        obs = [e for e in c.captured[0]["batch"] if e["type"] == "observation-create"]
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0]["body"]["model"], "gpt-4o")

    def test_tool_maps_to_span(self):
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="t")
        h.on_chain_start({}, {}, run_id="r1", parent_run_id=None)
        h.on_tool_start({"name": "search"}, "query", run_id="r3", parent_run_id="r1")
        h.on_tool_end("result", run_id="r3")
        h.on_chain_end({}, run_id="r1")
        obs = [e for e in c.captured[0]["batch"] if e["type"] == "observation-create"]
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0]["body"]["type"], "SPAN")
        self.assertEqual(obs[0]["body"]["name"], "search")

    def test_error_sets_error_level(self):
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="t")
        h.on_chain_start({}, {}, run_id="r1", parent_run_id=None)
        h.on_llm_start({"name": "llm"}, ["p"], run_id="r2", parent_run_id="r1")
        h.on_llm_error(RuntimeError("boom"), run_id="r2")
        h.on_chain_end({}, run_id="r1")
        obs = [e for e in c.captured[0]["batch"] if e["type"] == "observation-create"]
        self.assertEqual(obs[0]["body"]["level"], "ERROR")
        self.assertIn("boom", obs[0]["body"]["output"])

    def test_flush_sorting_shared(self):
        # 回调 flush 复用 client 排序（trace 先）
        c = FakeClient()
        h = MachoraCallbackHandler(client=c, trace_name="t")
        h.on_chain_start({}, {}, run_id="r1", parent_run_id=None)
        h.on_tool_start({"name": "tool"}, "x", run_id="r2", parent_run_id="r1")
        h.on_tool_end("y", run_id="r2")
        h.on_chain_end({}, run_id="r1")
        types = [e["type"] for e in c.captured[0]["batch"]]
        self.assertEqual(types, ["trace-create", "observation-create"])
        self.assertIn("trace-create", types)
        self.assertLess(
            types.index("trace-create"), types.index("observation-create")
        )


if __name__ == "__main__":
    unittest.main()
