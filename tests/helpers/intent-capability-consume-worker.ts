import { parentPort, workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";
import type { createStore as CreateStore, IntentCapabilityOperationScope } from "../../src/db/store.js";

interface WorkerInput {
  databasePath: string;
  scope: IntentCapabilityOperationScope;
  storeModuleUrl: string;
}

const input = workerData as WorkerInput;
register();
const { createStore } = await import(input.storeModuleUrl) as { createStore: typeof CreateStore };
const store = createStore(input.databasePath);

parentPort?.postMessage({ state: "ready" });
parentPort?.once("message", () => {
  try {
    parentPort?.postMessage({ state: "result", result: store.consumeIntentCapabilityForOperation(input.scope) });
  } catch (error) {
    parentPort?.postMessage({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    store.close();
  }
});
