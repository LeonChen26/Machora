// Machora 原生探针插件入口（machora.* 语义）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMachoraOpenInferenceService } from "./runtime-api.js";

export default definePluginEntry({
  id: "machora-openinference",
  name: "Machora OpenInference",
  description: "Export OpenClaw diagnostics as machora.* spans to Machora",
  register(api) {
    api.registerService(createMachoraOpenInferenceService());
  },
});
