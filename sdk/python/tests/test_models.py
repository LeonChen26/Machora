"""数据模型与序列化测试。"""

import unittest

from machora._models import (
    ObservationBody,
    ScoreBody,
    TraceBody,
    event_payload,
    score_data_type,
)


class TestModels(unittest.TestCase):
    def test_trace_payload_camel_case(self):
        body = TraceBody(
            id="t1",
            name="agent",
            timestamp="2026-08-02T00:00:00.000Z",
            user_id="u-1",
            session_id="s-1",
        )
        b = event_payload(body)
        self.assertEqual(b["userId"], "u-1")
        self.assertEqual(b["sessionId"], "s-1")
        self.assertEqual(b["environment"], "default")
        self.assertEqual(b["tags"], [])
        self.assertNotIn("user_id", b)

    def test_observation_payload_camel_case(self):
        body = ObservationBody(
            id="o1",
            trace_id="t1",
            type="LLM",
            start_time="2026-08-02T00:00:00.000Z",
            end_time="2026-08-02T00:00:01.000Z",
            usage={"prompt_tokens": 10},
        )
        b = event_payload(body)
        self.assertEqual(b["traceId"], "t1")
        self.assertEqual(b["startTime"], "2026-08-02T00:00:00.000Z")
        self.assertEqual(b["endTime"], "2026-08-02T00:00:01.000Z")
        self.assertEqual(b["usage"], {"prompt_tokens": 10})
        self.assertEqual(b["level"], "DEFAULT")

    def test_score_payload_and_defaults(self):
        body = ScoreBody(
            name="quality",
            value=0.9,
            data_type="NUMERIC",
            trace_id="t1",
        )
        b = event_payload(body)
        self.assertEqual(b["dataType"], "NUMERIC")
        self.assertEqual(b["source"], "API")
        self.assertEqual(b["traceId"], "t1")
        self.assertIsNone(b["id"])

    def test_score_data_type_inference(self):
        self.assertEqual(score_data_type(0.9), "NUMERIC")
        self.assertEqual(score_data_type(5), "NUMERIC")
        self.assertEqual(score_data_type(True), "BOOLEAN")
        self.assertEqual(score_data_type("good"), "CATEGORICAL")


if __name__ == "__main__":
    unittest.main()
