// async_hooks stand-in for @langchain/core, which keeps run context (callbacks,
// config) in an AsyncLocalStorage. A browser has no async context tracking, so the
// store is only guaranteed within the synchronous part of run(); LangChain also
// passes config explicitly, which is what carries it across awaits.
export class AsyncLocalStorage {
  constructor() {
    this.store = undefined;
  }
  getStore() {
    return this.store;
  }
  run(store, callback, ...args) {
    const previous = this.store;
    this.store = store;
    try {
      return callback(...args);
    } finally {
      this.store = previous;
    }
  }
  enterWith(store) {
    this.store = store;
  }
  disable() {
    this.store = undefined;
  }
}
export default { AsyncLocalStorage };
