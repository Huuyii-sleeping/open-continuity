/** Compatibility entry point. Storage contracts and implementations are separate. */
export type { MemoryStore, MemoryReceiptLike } from "./memory/contracts.js";
export { InMemoryStore } from "../storage/inmemory/store.js";
export { JsonFileStore } from "../storage/json/store.js";
