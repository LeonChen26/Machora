"""客户端行为测试（MockTransport，不发真实网络请求）。"""

import json
import unittest

import httpx

from machora import MachoraClient, MachoraError
from machora._client import utcnow_iso


class FakeClient(MachoraClient):
    """把 httpx 换成 MockTransport，记录收到的请求。"""

    def __init__(self):
        super().__init__(
            public_key="pk-test",
            secret_key="sk-test",
            host="http://test.local",
        )
        self.captured: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            self.captured.append(
                {
                    "url": str(request.url),
                    "headers": dict(request.headers),
                    "body": json.loads(request.content),
                }
            )
            return httpx.Response(200, json={"success": True, "received": 1, "errors": []})

        self._http = httpx.Client(transport=httpx.MockTransport(handler))

    def flush(self):
        return super().flush()


class TestClient(unittest.TestCase):
    def test_basic_auth_header(self):
        c = FakeClient()
        c.create_trace(name="t")
        c.flush()
        req = c.captured[0]
        self.assertEqual(req["url"], "http://test.local/api/public/ingestion")
        import base64

        expected = base64.b64encode(b"pk-test:sk-test").decode()
        self.assertEqual(req["headers"]["authorization"], f"Basic {expected}")

    def test_flush_sorts_trace_first(self):
        c = FakeClient()
        # 乱序插入：observation 先、trace 后
        c.create_observation("t1", name="obs")
        c.create_score("quality", 0.9, trace_id="t1")
        c.create_trace(name="t", trace_id="t1")
        c.flush()
        batch = c.captured[0]["body"]["batch"]
        types = [e["type"] for e in batch]
        self.assertEqual(types, ["trace-create", "observation-create", "score-create"])
        self.assertEqual(batch[0]["body"]["id"], "t1")

    def test_trace_context_manager_auto_flush(self):
        c = FakeClient()
        with c.trace(name="agent") as t:
            with t.span(name="tool") as s:
                s.end(output={"ok": True})
        self.assertEqual(len(c.captured), 1)
        batch = c.captured[0]["body"]["batch"]
        self.assertEqual([e["type"] for e in batch], ["trace-create", "observation-create"])
        obs = batch[1]["body"]
        self.assertEqual(obs["name"], "tool")
        self.assertIsNotNone(obs["endTime"])

    def test_generation_with_usage(self):
        c = FakeClient()
        t = c.trace(name="agent")
        gen = t.generation(
            name="chat",
            model="gpt-4o-mini",
            input={"content": "hi"},
            usage={"prompt_tokens": 10, "completion_tokens": 5},
        )
        gen.end(output={"content": "hello"})
        t.flush()
        batch = c.captured[0]["body"]["batch"]
        obs = batch[1]["body"]
        self.assertEqual(obs["type"], "GENERATION")
        self.assertEqual(obs["model"], "gpt-4o-mini")
        self.assertEqual(obs["usage"], {"prompt_tokens": 10, "completion_tokens": 5})
        self.assertEqual(obs["output"], {"content": "hello"})

    def test_score_data_type_inferred(self):
        c = FakeClient()
        tid = c.create_trace(name="t")
        c.create_score("ok", True, trace_id=tid)
        c.create_score("grade", "A", trace_id=tid)
        c.create_score("score", 0.8, trace_id=tid)
        c.flush()
        batch = c.captured[0]["body"]["batch"]
        dtypes = [e["body"]["dataType"] for e in batch if e["type"] == "score-create"]
        self.assertEqual(dtypes, ["BOOLEAN", "CATEGORICAL", "NUMERIC"])

    def test_http_error_raises(self):
        c = FakeClient()

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "Invalid API key"})

        c._http = httpx.Client(transport=httpx.MockTransport(handler))
        c.create_trace(name="t")
        with self.assertRaises(MachoraError) as ctx:
            c.flush()
        self.assertIn("401", str(ctx.exception))

    def test_span_end_idempotent(self):
        c = FakeClient()
        t = c.trace(name="t")
        s = t.span(name="s")
        s.end(output={"a": 1})
        s.end(output={"a": 2})  # 第二次调用忽略
        t.flush()
        batch = c.captured[0]["body"]["batch"]
        self.assertEqual(len([e for e in batch if e["type"] == "observation-create"]), 1)

    def test_utcnow_iso_zulu(self):
        ts = utcnow_iso()
        self.assertTrue(ts.endswith("Z"))


if __name__ == "__main__":
    unittest.main()
