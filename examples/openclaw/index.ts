// Machora OpenInference probe plugin entrypoint.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMachoraOpenInferenceService } from "./runtime-api.js";

export default definePluginEntry({
  id: "machora-openinference",
  name: "Machora OpenInference",
  description: "Export OpenClaw diagnostics as OpenInference spans to Machora",
  register(api) {
    api.registerService(createMachoraOpenInferenceService());
  },
});
