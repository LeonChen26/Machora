// 独立 worker 入口（非 standalone 模式用，需 Redis）
// standalone 模式下不走这里，由 start.ts 直接 import registerQueueProcessors
import { registerQueueProcessors } from "./app.js";

registerQueueProcessors();
console.log("[worker] standalone worker running...");
