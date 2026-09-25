import { contains2, len2, set3, dict3, bufferExports, ChatOpenAI, createAgent, AIMessage, AIMessageChunk, mapChatMessagesToStoredMessages, jsonrepair } from "../vendor/libraries.mjs";
import { process } from "../browser/process.mjs";
import { exposeClassAttributes, posix, fileURLToPath, fs, join, existsSync, createRequire } from "../browser/shims.mjs";
function is_plain_object(value) {
  return typeof value === "object" && value !== null && !(Symbol.iterator in Object(value));
}
function contains(item, container) {
  if (container === null || container === void 0) {
    return false;
  }
  if (is_plain_object(container)) {
    return Object.prototype.hasOwnProperty.call(container, item);
  }
  return contains2(item, container);
}
function len(container) {
  if (is_plain_object(container)) {
    return Object.keys(container).length;
  }
  return len2(container);
}
function deepcopy(value, seen = /* @__PURE__ */ new WeakMap()) {
  if (value === null || typeof value !== "object" && typeof value !== "function") {
    return value;
  }
  if (typeof value === "function") {
    return value;
  }
  const already = seen.get(value);
  if (already !== void 0) {
    return already;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags);
  }
  if (Array.isArray(value)) {
    const copy2 = [];
    seen.set(value, copy2);
    for (const entry of value) {
      copy2.push(deepcopy(entry, seen));
    }
    return copy2;
  }
  if (value instanceof Map) {
    const copy2 = /* @__PURE__ */ new Map();
    seen.set(value, copy2);
    for (const [key, entry] of value) {
      copy2.set(deepcopy(key, seen), deepcopy(entry, seen));
    }
    return copy2;
  }
  if (value instanceof Set) {
    const copy2 = /* @__PURE__ */ new Set();
    seen.set(value, copy2);
    for (const entry of value) {
      copy2.add(deepcopy(entry, seen));
    }
    return copy2;
  }
  const copy = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === void 0) {
      continue;
    }
    if ("value" in descriptor) {
      descriptor.value = deepcopy(descriptor.value, seen);
    }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}
function is_dict(value) {
  if (value instanceof Map) {
    return true;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function set(value) {
  if (value === void 0 || value === null) {
    return /* @__PURE__ */ new Set();
  }
  if (is_plain_object(value)) {
    return new Set(Object.keys(value));
  }
  return set3(value);
}
const dict = Object.assign(
  // (vibed) python's dict(x) copies, and every transpiled python dict is a plain
  // object, so this returns one. pythonlib's dict() is new Map(x), which throws for
  // a plain object; BaseToolFactory.create_function_tool calls dict(function_json).
  (entries) => entries == null ? {} : entries instanceof Map || typeof entries[Symbol.iterator] === "function" ? Object.fromEntries(entries) : { ...entries },
  dict3,
  {
    get(container, key, default_value) {
      if (container instanceof Map) {
        return container.has(key) ? container.get(key) : default_value;
      }
      return dict3.get(container, key, default_value);
    }
  }
);
function is_instance_named(value, names) {
  const wanted = new Set(names);
  let proto = value === null || value === void 0 ? null : Object.getPrototypeOf(value);
  while (proto !== null && proto.constructor) {
    if (wanted.has(proto.constructor.name)) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}
function cpu_count() {
  const concurrency = globalThis.navigator?.hardwareConcurrency;
  return typeof concurrency === "number" && concurrency > 0 ? concurrency : 1;
}
const pathsep = typeof process !== "undefined" && process.platform === "win32" ? ";" : ":";
function addLevelName(_level, _name) {
}
let logRecordFactory = () => ({});
function getLogRecordFactory() {
  return logRecordFactory;
}
function setLogRecordFactory(factory) {
  logRecordFactory = factory;
}
function exc_info() {
  return [null, null, null];
}
const modules = {};
function fromTimestamp(secondsSinceEpoch) {
  return new Date(secondsSinceEpoch * 1e3);
}
function py_callable$1(cls) {
  return new Proxy(cls, {
    apply(target, _this_arg, args) {
      return new target(...args);
    }
  });
}
function is_kwargs(value, ...keys) {
  if (value === null || typeof value !== "object" || typeof value.then === "function") {
    return false;
  }
  return keys.some((key) => key in value);
}
class AsyncioTimeoutError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "TimeoutError";
  }
}
class AsyncioCancelledError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "CancelledError";
  }
}
class AsyncioInvalidStateError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "InvalidStateError";
  }
}
const TimeoutError$1 = py_callable$1(AsyncioTimeoutError);
const CancelledError = py_callable$1(AsyncioCancelledError);
const InvalidStateError = py_callable$1(AsyncioInvalidStateError);
class AsyncioFuture {
  /**
   * Constructor
   *
   * :param kwargs: Accepts a loop, the way asyncio.Future(loop=...) does
   */
  constructor(kwargs = {}) {
    this._state = "pending";
    this._result = void 0;
    this._exception = null;
    this._callbacks = [];
    this._loop = kwargs.loop ?? get_event_loop();
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    this._promise.catch(() => void 0);
  }
  /**
   * Makes the future awaitable.
   */
  then(on_fulfilled, on_rejected) {
    return this._promise.then(on_fulfilled, on_rejected);
  }
  /**
   * :return: True once the future has a result, an exception or a cancellation
   */
  done() {
    return this._state !== "pending";
  }
  /**
   * :return: True if the future was cancelled
   */
  cancelled() {
    return this._state === "cancelled";
  }
  /**
   * :return: The result of the future
   *
   * Note that unlike Python, this cannot wait. A pending future has no result
   * to give and no way to block for one, so asking for it is an error.
   */
  result(kwargs = {}) {
    if (this._state === "cancelled") {
      throw new AsyncioCancelledError("Future was cancelled");
    }
    if (this._state === "pending") {
      throw new AsyncioInvalidStateError("asyncio stub: cannot wait for a pending Future. JavaScript has no way to block the event loop, so await the future instead of calling result().");
    }
    if (this._exception !== null) {
      throw this._exception;
    }
    return this._result;
  }
  /**
   * :return: The exception the future completed with, or null if it succeeded
   */
  exception(kwargs = {}) {
    if (this._state === "cancelled") {
      throw new AsyncioCancelledError("Future was cancelled");
    }
    if (this._state === "pending") {
      throw new AsyncioInvalidStateError("Exception is not set: the Future is still pending");
    }
    return this._exception;
  }
  /**
   * :param result: The value to complete the future with
   *
   * Note that a result which is itself awaitable -- a Future or a Task -- comes
   * back from result() as the object it is, but "await future" hands back what
   * that inner awaitable resolves to. JavaScript flattens a promise of a
   * promise and there is no way to opt out of it.
   */
  set_result(result) {
    if (this.done()) {
      throw new AsyncioInvalidStateError(`invalid state: ${this._state}`);
    }
    this._state = "finished";
    this._result = result;
    this._resolve(result);
    this._schedule_callbacks();
  }
  /**
   * :param exception: The exception to complete the future with
   */
  set_exception(exception) {
    if (this.done()) {
      throw new AsyncioInvalidStateError(`invalid state: ${this._state}`);
    }
    this._state = "finished";
    this._exception = exception;
    this._reject(exception);
    this._schedule_callbacks();
  }
  /**
   * :param msg: An optional message describing the cancellation
   * :return: True if the future moved to the cancelled state
   */
  cancel(msg = null) {
    if (this.done()) {
      return false;
    }
    this._state = "cancelled";
    this._exception = new AsyncioCancelledError(msg ?? "");
    this._reject(this._exception);
    this._schedule_callbacks();
    return true;
  }
  /**
   * :param callback: Called with this future once it is done
   */
  add_done_callback(callback, kwargs = {}) {
    if (this.done()) {
      queueMicrotask(() => callback(this));
      return;
    }
    this._callbacks.push(callback);
  }
  /**
   * :param callback: The callback to remove
   * :return: The number of callbacks removed
   */
  remove_done_callback(callback) {
    let remaining = this._callbacks.filter((one_callback) => one_callback !== callback);
    let removed = this._callbacks.length - remaining.length;
    this._callbacks = remaining;
    return removed;
  }
  /**
   * :return: The event loop the future is bound to
   */
  get_loop() {
    return this._loop;
  }
  /**
   * Hand every registered callback the completed future, as the loop would.
   */
  _schedule_callbacks() {
    let callbacks = this._callbacks;
    this._callbacks = [];
    for (const callback of callbacks) {
      queueMicrotask(() => callback(this));
    }
  }
}
const ALL_TASKS = /* @__PURE__ */ new Set();
let CURRENT_TASK = null;
class AsyncioTask extends AsyncioFuture {
  /**
   * Constructor
   *
   * :param coro: The coroutine (a promise or a promise-returning function) to run
   * :param kwargs: Accepts name and loop, the way asyncio.Task(coro, name=...) does
   */
  constructor(coro, kwargs = {}) {
    super({ loop: kwargs.loop });
    this._coro = coro;
    this._name = kwargs.name ?? `Task-${ALL_TASKS.size + 1}`;
    ALL_TASKS.add(this);
    this.add_done_callback(() => ALL_TASKS.delete(this));
    let previous_task = CURRENT_TASK;
    CURRENT_TASK = this;
    try {
      let awaitable = typeof coro === "function" ? coro() : coro;
      Promise.resolve(awaitable).then((result) => {
        if (!this.done()) {
          this._with_current_task(() => this.set_result(result));
        }
      }, (exception) => {
        if (!this.done()) {
          this._with_current_task(() => this.set_exception(exception));
        }
      });
    } catch (exception) {
      this.set_exception(exception);
    } finally {
      CURRENT_TASK = previous_task;
    }
  }
  /**
   * :return: The name of the task
   */
  get_name() {
    return this._name;
  }
  /**
   * :param value: The name to give the task
   */
  set_name(value) {
    this._name = String(value);
  }
  /**
   * :return: The coroutine the task wraps
   */
  get_coro() {
    return this._coro;
  }
  /**
   * :return: The stack of the coroutine. Always empty: JavaScript keeps no
   * frame objects for a suspended promise.
   */
  get_stack(kwargs = {}) {
    return [];
  }
  /**
   * Print the stack of the coroutine. A no-op for the same reason get_stack()
   * is empty.
   */
  print_stack(kwargs = {}) {
    return;
  }
  /**
   * :param callback: Run with this task installed as the current one
   */
  _with_current_task(callback) {
    let previous_task = CURRENT_TASK;
    CURRENT_TASK = this;
    try {
      callback();
    } finally {
      CURRENT_TASK = previous_task;
    }
  }
}
const Future$1 = py_callable$1(AsyncioFuture);
const Task = py_callable$1(AsyncioTask);
class AsyncioTimerHandle {
  constructor(timer = null) {
    this._timer = timer;
    this._cancelled = false;
  }
  cancel() {
    this._cancelled = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
    }
  }
  cancelled() {
    return this._cancelled;
  }
}
class AsyncioAbstractEventLoop {
  constructor() {
    this._running = false;
    this._closed = false;
    this._debug = false;
    this._exception_handler = null;
    this._task_factory = null;
    this._default_executor = null;
  }
  /**
   * :return: True if the loop is running
   */
  is_running() {
    return this._running && !this._closed;
  }
  /**
   * :return: True if the loop has been closed
   */
  is_closed() {
    return this._closed;
  }
  /**
   * Marks the loop running.
   *
   * In Python this blocks the calling thread until stop() is called. Here the
   * host loop is already running and there is no thread to block, so this
   * returns as soon as the loop is marked running.
   */
  run_forever() {
    if (this._closed) {
      throw new Error("Event loop is closed");
    }
    this._running = true;
  }
  /**
   * :param awaitable: The coroutine or future to run
   * :return: A promise for the result
   *
   * Python blocks until the awaitable is done and hands back its result. Here
   * the promise itself is the return value: callers have to await it.
   */
  run_until_complete(awaitable) {
    if (this._closed) {
      throw new Error("Event loop is closed");
    }
    this._running = true;
    return Promise.resolve(awaitable);
  }
  /**
   * Marks the loop stopped. Pending work already handed to the host loop still runs.
   */
  stop() {
    this._running = false;
  }
  /**
   * Marks the loop closed.
   */
  close() {
    this._running = false;
    this._closed = true;
  }
  /**
   * :param awaitable: The coroutine to schedule
   * :param kwargs: Accepts name and context, the way loop.create_task(coro, name=...) does
   * :return: The Task wrapping it
   */
  create_task(awaitable, kwargs = {}) {
    if (this._closed) {
      throw new Error("Event loop is closed");
    }
    if (this._task_factory !== null) {
      return this._task_factory(this, awaitable, kwargs);
    }
    return new AsyncioTask(awaitable, { name: kwargs.name, loop: this });
  }
  /**
   * :param awaitable: The coroutine or future to schedule
   * :return: The Task wrapping it
   */
  ensure_future(awaitable) {
    if (awaitable instanceof AsyncioTask) {
      return awaitable;
    }
    return this.create_task(awaitable);
  }
  /**
   * :param callback: The function to call on the next turn of the loop
   * :param args: Arguments to call it with
   * :return: A handle the caller can cancel
   */
  call_soon(callback, ...args) {
    let handle = new AsyncioTimerHandle();
    queueMicrotask(() => {
      if (!handle.cancelled()) {
        this._run_callback(callback, args);
      }
    });
    return handle;
  }
  /**
   * The same as call_soon(). There are no other threads to be safe from.
   */
  call_soon_threadsafe(callback, ...args) {
    return this.call_soon(callback, ...args);
  }
  /**
   * :param delay: Seconds to wait before calling the callback
   * :param callback: The function to call
   * :param args: Arguments to call it with
   * :return: A handle the caller can cancel
   */
  call_later(delay, callback, ...args) {
    let handle = new AsyncioTimerHandle();
    handle._timer = setTimeout(() => {
      if (!handle.cancelled()) {
        this._run_callback(callback, args);
      }
    }, delay * 1e3);
    return handle;
  }
  /**
   * :param executor: The executor to run sync functions in. Kept so that
   * loop.set_default_executor() call sites work; nothing here uses it, since
   * run_in_executor() has no thread pool to hand work to.
   */
  set_default_executor(executor) {
    this._default_executor = executor;
  }
  /**
   * :param executor: Ignored, as in Python when it is None
   * :param func: The function to run
   * :param args: Arguments to call it with
   * :return: A promise for the result. The function runs inline: no threads.
   */
  run_in_executor(executor, func, ...args) {
    return to_thread(func, ...args);
  }
  /**
   * :param factory: Called as factory(loop, coro, **kwargs) to make each task
   */
  set_task_factory(factory) {
    this._task_factory = factory;
  }
  /**
   * :return: The task factory, or null if tasks are made the default way
   */
  get_task_factory() {
    return this._task_factory;
  }
  /**
   * :param handler: Called as handler(loop, context) for loop-level exceptions
   */
  set_exception_handler(handler) {
    this._exception_handler = handler;
  }
  /**
   * :return: The custom exception handler, or null if there is none
   */
  get_exception_handler() {
    return this._exception_handler;
  }
  /**
   * :param context: A dict describing the exception, per the Python docs
   */
  default_exception_handler(context) {
    let message = context["message"] ?? "Unhandled exception in event loop";
    let exception = context["exception"] ?? null;
    console.error(message, exception);
  }
  /**
   * :param context: A dict describing the exception, per the Python docs
   */
  call_exception_handler(context) {
    if (this._exception_handler === null) {
      this.default_exception_handler(context);
      return;
    }
    try {
      this._exception_handler(this, context);
    } catch (exception) {
      this.default_exception_handler({ "message": "Exception in exception handler", "exception": exception });
    }
  }
  /**
   * :return: Seconds from an arbitrary origin, the loop's monotonic clock
   */
  time() {
    return performance.now() / 1e3;
  }
  /**
   * :return: True if the loop is in debug mode
   */
  get_debug() {
    return this._debug;
  }
  /**
   * :param enabled: True to put the loop in debug mode
   */
  set_debug(enabled) {
    this._debug = enabled;
  }
  /**
   * Run one scheduled callback, routing anything it throws to the exception handler.
   */
  _run_callback(callback, args) {
    try {
      let result = callback(...args);
      if (result !== null && typeof result?.then === "function") {
        Promise.resolve(result).catch((exception) => {
          this.call_exception_handler({ "message": "Exception in callback", "exception": exception });
        });
      }
    } catch (exception) {
      this.call_exception_handler({ "message": "Exception in callback", "exception": exception });
    }
  }
}
class AsyncioSelectorEventLoop extends AsyncioAbstractEventLoop {
}
const AbstractEventLoop = py_callable$1(AsyncioAbstractEventLoop);
const SelectorEventLoop = py_callable$1(AsyncioSelectorEventLoop);
const TimerHandle = py_callable$1(AsyncioTimerHandle);
let EVENT_LOOP = null;
function new_event_loop() {
  return new AsyncioSelectorEventLoop();
}
function set_event_loop(loop) {
  EVENT_LOOP = loop;
  if (loop !== null && !loop.is_closed()) {
    loop.run_forever();
  }
}
function get_event_loop() {
  if (EVENT_LOOP === null || EVENT_LOOP.is_closed()) {
    EVENT_LOOP = new_event_loop();
    EVENT_LOOP.run_forever();
  }
  return EVENT_LOOP;
}
function get_running_loop() {
  return get_event_loop();
}
function create_task(awaitable, kwargs = {}) {
  return get_event_loop().create_task(awaitable, kwargs);
}
function ensure_future(awaitable, kwargs = {}) {
  let loop = kwargs.loop ?? get_event_loop();
  return loop.ensure_future(awaitable);
}
function eager_task_factory(loop, coro, kwargs = {}) {
  return new AsyncioTask(coro, { name: kwargs.name, loop });
}
function all_tasks(kwargs = {}) {
  let tasks = /* @__PURE__ */ new Set();
  for (const task of ALL_TASKS) {
    if (task.done()) {
      continue;
    }
    if (kwargs.loop !== void 0 && kwargs.loop !== null && task.get_loop() !== kwargs.loop) {
      continue;
    }
    tasks.add(task);
  }
  return tasks;
}
function current_task(kwargs = {}) {
  return CURRENT_TASK;
}
function gather(...args) {
  let awaitables = args;
  let return_exceptions = false;
  if (args.length > 0 && is_kwargs(args[args.length - 1], "return_exceptions")) {
    return_exceptions = Boolean(args[args.length - 1].return_exceptions);
    awaitables = args.slice(0, -1);
  }
  if (!return_exceptions) {
    return Promise.all(awaitables.map((awaitable) => Promise.resolve(awaitable)));
  }
  return Promise.all(awaitables.map((awaitable) => Promise.resolve(awaitable).catch((exception) => exception)));
}
function wait_for(awaitable, timeout = null) {
  if (timeout === null || timeout === void 0) {
    return Promise.resolve(awaitable);
  }
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      if (awaitable instanceof AsyncioFuture) {
        awaitable.cancel("wait_for timeout");
      }
      reject(new AsyncioTimeoutError(`Timed out after ${timeout} seconds`));
    }, timeout * 1e3);
    Promise.resolve(awaitable).then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (exception) => {
      clearTimeout(timer);
      reject(exception);
    });
  });
}
function sleep(delay, result = null) {
  return new Promise((resolve) => setTimeout(() => resolve(result), delay * 1e3));
}
function to_thread(func, ...args) {
  return Promise.resolve().then(() => func(...args));
}
function run_coroutine_threadsafe(coro, loop) {
  let future = new AsyncioFuture({ loop });
  Promise.resolve(coro).then((result) => {
    if (!future.done()) {
      future.set_result(result);
    }
  }, (exception) => {
    if (!future.done()) {
      future.set_exception(exception);
    }
  });
  return future;
}
class AsyncioEvent {
  constructor() {
    this._value = false;
    this._waiters = [];
  }
  /**
   * :return: True if the flag is set
   */
  is_set() {
    return this._value;
  }
  /**
   * Sets the flag and wakes everything waiting on it.
   */
  set() {
    if (this._value) {
      return;
    }
    this._value = true;
    let waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
  /**
   * Clears the flag. Later waiters block again.
   */
  clear() {
    this._value = false;
  }
  /**
   * :return: A promise that resolves once the flag is set
   */
  wait() {
    if (this._value) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this._waiters.push(() => resolve(true));
    });
  }
}
class AsyncioLock {
  constructor() {
    this._locked = false;
    this._waiters = [];
  }
  /**
   * :return: True if the lock is held
   */
  locked() {
    return this._locked;
  }
  /**
   * :return: A promise that resolves once the lock is held
   */
  acquire() {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this._waiters.push(() => resolve(true));
    });
  }
  /**
   * Releases the lock, handing it to the next waiter if there is one.
   */
  release() {
    if (!this._locked) {
      return;
    }
    let waiter = this._waiters.shift();
    if (waiter === void 0) {
      this._locked = false;
      return;
    }
    waiter();
  }
  /**
   * Releases the lock at the end of a "with" block.
   */
  close() {
    this.release();
  }
}
class AsyncioSemaphore {
  constructor(value = 1) {
    this._value = value;
    this._waiters = [];
  }
  /**
   * :return: True if no permits are left
   */
  locked() {
    return this._value <= 0;
  }
  /**
   * :return: A promise that resolves once a permit is taken
   */
  acquire() {
    if (this._value > 0) {
      this._value -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this._waiters.push(() => resolve(true));
    });
  }
  /**
   * Gives a permit back, handing it to the next waiter if there is one.
   */
  release() {
    let waiter = this._waiters.shift();
    if (waiter === void 0) {
      this._value += 1;
      return;
    }
    waiter();
  }
  /**
   * Releases the permit at the end of a "with" block.
   */
  close() {
    this.release();
  }
}
const DISPOSE_SYMBOL$1 = Symbol.dispose ?? /* @__PURE__ */ Symbol.for("Symbol.dispose");
AsyncioLock.prototype[DISPOSE_SYMBOL$1] = function() {
  this.release();
  return true;
};
AsyncioSemaphore.prototype[DISPOSE_SYMBOL$1] = function() {
  this.release();
  return true;
};
const Event$1 = py_callable$1(AsyncioEvent);
const Lock$1 = py_callable$1(AsyncioLock);
const Semaphore$1 = py_callable$1(AsyncioSemaphore);
const Future = Future$1;
const TimeoutError = TimeoutError$1;
class ThreadPoolExecutor {
  constructor() {
    this._threads = /* @__PURE__ */ new Set();
  }
  submit(fn, ...args) {
    const future = new Future();
    try {
      future.set_result(fn(...args));
    } catch (error) {
      future.set_exception(error);
    }
    return future;
  }
  shutdown() {
  }
}
class ProcessPoolExecutor {
}
exposeClassAttributes(ThreadPoolExecutor);
exposeClassAttributes(ProcessPoolExecutor);
const _handler$6 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$6);
    const fn = (..._a) => new Proxy({}, _handler$6);
    return new Proxy(fn, _handler$6);
  },
  apply() {
    return new Proxy({}, _handler$6);
  },
  construct() {
    return new Proxy({}, _handler$6);
  }
};
const _stub$7 = new Proxy({}, _handler$6);
const get_context = _stub$7.get_context;
class FileOfClass {
  constructor(basis) {
    this.basis = basis;
  }
  get_file_in_basis(relative) {
    return this.basis ? posix.join(this.basis, relative) : relative;
  }
}
const PACKAGED_DATA = posix.join(posix.dirname(fileURLToPath(import.meta.url)), "..", "data");
const PACKAGE_BASIS = process.env.NEURO_SAN_ROOT ?? PACKAGED_DATA;
const TOP_LEVEL_DIR = new FileOfClass(PACKAGE_BASIS);
const REGISTRIES_DIR = new FileOfClass(PACKAGE_BASIS ? posix.join(PACKAGE_BASIS, "registries") : "");
exposeClassAttributes(FileOfClass);
function get_deep_size(obj, value) {
  return 0;
}
function open$1(path, mode = "r") {
  const binary = String(mode).includes("b");
  const data = binary ? fs.readFileSync(path) : fs.readFileSync(path, "utf8");
  return {
    read() {
      return data;
    },
    close() {
    }
  };
}
function next(iterable, ...fallback) {
  const iterator = typeof iterable.next === "function" ? iterable : iterable[Symbol.iterator]();
  const result = iterator.next();
  if (!result.done) {
    return result.value;
  }
  if (fallback.length > 0) {
    return fallback[0];
  }
  throw new Error("StopIteration");
}
function frozenset(iterable = []) {
  return new Set(iterable);
}
function issubclass(subject, base) {
  if (typeof subject !== "function" || typeof base !== "function") {
    return false;
  }
  return subject === base || subject.prototype instanceof base;
}
function callable(subject) {
  return typeof subject === "function";
}
class NullContext {
  constructor(enter_result = null) {
    this.enter_result = enter_result;
  }
  close() {
  }
}
function nullcontext(enter_result = null) {
  return new NullContext(enter_result);
}
function suppress(...value) {
  return new NullContext();
}
function contextmanager(my_function) {
  return (...args) => {
    const iterator = my_function(...args);
    const first = iterator.next();
    if (first.done) {
      throw new TypeError("generator did not yield");
    }
    const value = first.value;
    if (value === null || typeof value !== "object" && typeof value !== "function") {
      iterator.return();
      return value;
    }
    const holder = value;
    const previous_close = typeof holder.close === "function" ? holder.close.bind(holder) : null;
    holder.close = () => {
      if (previous_close !== null) {
        previous_close();
      }
      iterator.return();
    };
    return value;
  };
}
exposeClassAttributes(NullContext);
class BytesIO {
  constructor(buf) {
    if (bufferExports.Buffer.isBuffer(buf))
      this._buf = buf;
    else if (buf instanceof Uint8Array)
      this._buf = bufferExports.Buffer.from(buf);
    else if (typeof buf === "string")
      this._buf = bufferExports.Buffer.from(buf);
    else if (buf == null)
      this._buf = bufferExports.Buffer.alloc(0);
    else
      this._buf = bufferExports.Buffer.from(buf);
    this._pos = 0;
  }
  getvalue() {
    return this._buf;
  }
  read(n) {
    if (n == null || n === void 0) {
      const out2 = this._buf.subarray(this._pos);
      this._pos = this._buf.length;
      return out2;
    }
    const out = this._buf.subarray(this._pos, this._pos + n);
    this._pos += out.length;
    return out;
  }
  seek(pos) {
    this._pos = pos;
    return this._pos;
  }
  tell() {
    return this._pos;
  }
  close() {
  }
}
class StringIO {
  constructor(s = "") {
    this._s = String(s);
    this._pos = 0;
  }
  getvalue() {
    return this._s;
  }
  read(n) {
    if (n == null || n === void 0) {
      const out2 = this._s.slice(this._pos);
      this._pos = this._s.length;
      return out2;
    }
    const out = this._s.slice(this._pos, this._pos + n);
    this._pos += out.length;
    return out;
  }
  seek(pos) {
    this._pos = pos;
    return this._pos;
  }
  close() {
  }
}
const io = { BytesIO, StringIO };
exposeClassAttributes(BytesIO);
exposeClassAttributes(StringIO);
const _handler$5 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$5);
    const fn = (..._a) => new Proxy({}, _handler$5);
    return new Proxy(fn, _handler$5);
  },
  apply() {
    return new Proxy({}, _handler$5);
  },
  construct() {
    return new Proxy({}, _handler$5);
  }
};
const _stub$6 = new Proxy({}, _handler$5);
const open = _stub$6.open;
function py_callable(cls) {
  return new Proxy(cls, {
    apply(target, _this_arg, args) {
      return new target(...args);
    }
  });
}
function timeout_of(value) {
  if (value === null || value === void 0) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "object" && "timeout" in value) {
    let timeout = value.timeout;
    return timeout === null || timeout === void 0 ? null : Number(timeout);
  }
  return null;
}
const MAIN_THREAD_IDENT = 1;
const TIMEOUT_MAX = 4294967;
class ThreadingLock {
  constructor() {
    this._locked = false;
  }
  /**
   * :param blocking: Kept for signature compatibility. Nothing blocks here.
   * :param timeout: Kept for signature compatibility. Nothing blocks here.
   * :return: True, always
   */
  acquire(blocking = true, timeout = -1) {
    this._locked = true;
    return true;
  }
  /**
   * Releases the lock. A no-op if it is not held.
   */
  release() {
    this._locked = false;
  }
  /**
   * :return: True if the lock is held
   */
  locked() {
    return this._locked;
  }
  /**
   * Releases the lock at the end of a "with" block.
   */
  close() {
    this.release();
  }
}
class ThreadingRLock {
  constructor() {
    this._count = 0;
  }
  /**
   * :param blocking: Kept for signature compatibility. Nothing blocks here.
   * :param timeout: Kept for signature compatibility. Nothing blocks here.
   * :return: True, always
   */
  acquire(blocking = true, timeout = -1) {
    this._count += 1;
    return true;
  }
  /**
   * Gives up one level of the lock. A no-op if it is not held.
   */
  release() {
    if (this._count > 0) {
      this._count -= 1;
    }
  }
  /**
   * :return: True if the lock is held at least once
   */
  locked() {
    return this._count > 0;
  }
  /**
   * Gives up one level of the lock at the end of a "with" block.
   */
  close() {
    this.release();
  }
}
class ThreadingSemaphore {
  constructor(value = 1) {
    this._value = value;
  }
  /**
   * :param blocking: Kept for signature compatibility. Nothing blocks here.
   * :param timeout: Kept for signature compatibility. Nothing blocks here.
   * :return: True, always
   */
  acquire(blocking = true, timeout = -1) {
    this._value -= 1;
    return true;
  }
  /**
   * :param n: How many permits to give back
   */
  release(n = 1) {
    this._value += n;
  }
  /**
   * Gives a permit back at the end of a "with" block.
   */
  close() {
    this.release();
  }
}
class ThreadingEvent {
  constructor() {
    this._value = false;
    this._waiters = [];
  }
  /**
   * :return: True if the flag is set
   */
  is_set() {
    return this._value;
  }
  /**
   * Sets the flag and wakes everything waiting on it.
   */
  set() {
    if (this._value) {
      return;
    }
    this._value = true;
    let waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) {
      waiter(true);
    }
  }
  /**
   * Clears the flag. Later waiters wait again.
   */
  clear() {
    this._value = false;
  }
  /**
   * :param args: An optional timeout in seconds, passed either positionally or
   * in the kwargs object python2ts appends
   * :return: A promise for True once the flag is set, or False if the timeout
   * passes first. Python hands back that boolean directly; a promise is as
   * close as this gets, so callers have to await it.
   */
  wait(...args) {
    if (this._value) {
      return Promise.resolve(true);
    }
    let timeout = timeout_of(args[0]);
    return new Promise((resolve) => {
      let timer = null;
      let waiter = (was_set) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve(was_set);
      };
      this._waiters.push(waiter);
      if (timeout !== null) {
        timer = setTimeout(() => {
          this._waiters = this._waiters.filter((one_waiter) => one_waiter !== waiter);
          resolve(false);
        }, timeout * 1e3);
      }
    });
  }
}
class ThreadingLocal {
}
let THREAD_COUNT = 1;
class ThreadingThread {
  /**
   * Constructor
   *
   * :param kwargs: Accepts target, args, kwargs, name and daemon, the way
   * Python's Thread(target=..., daemon=True) does
   */
  constructor(kwargs = {}) {
    this._target = kwargs.target ?? null;
    this._args = Array.from(kwargs.args ?? []);
    this._kwargs = kwargs.kwargs ?? {};
    this._started = false;
    this.name = kwargs.name ?? `Thread-${THREAD_COUNT++}`;
    this.daemon = kwargs.daemon ?? false;
    this.ident = null;
    this.native_id = null;
    this["this"] = {};
  }
  /**
   * Would start the thread. Warns and returns instead.
   *
   * The Thread counts as started afterwards, and reports the id of the one
   * thread there is, so that "am I on that thread?" checks answer yes. What it
   * does not do is run the target: see the note at the top of this file.
   */
  start() {
    if (this._started) {
      throw new Error("threads can only be started once");
    }
    this._started = true;
    this.ident = MAIN_THREAD_IDENT;
    this.native_id = MAIN_THREAD_IDENT;
    let target_name = this._target === null ? "no target" : this._target.name || "anonymous target";
    console.warn(`threading stub: Thread "${this.name}".start() did not run ${target_name}: JavaScript has no threads to run it on. Port the body to a coroutine, or call run() to run it inline on the one thread there is.`);
  }
  /**
   * Runs the target here and now, on the calling thread, as Python's
   * Thread.run() does. Nothing calls this for you.
   *
   * :return: Whatever the target returns
   */
  run() {
    if (this._target === null) {
      return null;
    }
    return this._target(...this._args, this._kwargs);
  }
  /**
   * :param args: An optional timeout in seconds, ignored
   * :return: A promise that is already resolved
   *
   * There is no thread to wait for. Python blocks until the thread finishes;
   * this returns straight away.
   */
  join(...args) {
    return Promise.resolve();
  }
  /**
   * :return: False. The target never ran, so nothing is alive.
   */
  is_alive() {
    return false;
  }
}
const MAIN_THREAD = new ThreadingThread({ name: "MainThread" });
MAIN_THREAD.ident = MAIN_THREAD_IDENT;
MAIN_THREAD.native_id = MAIN_THREAD_IDENT;
MAIN_THREAD._started = true;
function current_thread() {
  return MAIN_THREAD;
}
function main_thread() {
  return MAIN_THREAD;
}
function get_ident() {
  return MAIN_THREAD_IDENT;
}
function get_native_id() {
  return MAIN_THREAD_IDENT;
}
function active_count() {
  return 1;
}
function enumerate() {
  return [MAIN_THREAD];
}
const DISPOSE_SYMBOL = Symbol.dispose ?? /* @__PURE__ */ Symbol.for("Symbol.dispose");
ThreadingLock.prototype[DISPOSE_SYMBOL] = function() {
  this.release();
  return true;
};
ThreadingRLock.prototype[DISPOSE_SYMBOL] = function() {
  this.release();
  return true;
};
ThreadingSemaphore.prototype[DISPOSE_SYMBOL] = function() {
  this.release();
  return true;
};
const Lock = py_callable(ThreadingLock);
const RLock = py_callable(ThreadingRLock);
const Semaphore = py_callable(ThreadingSemaphore);
const Event = py_callable(ThreadingEvent);
const local = py_callable(ThreadingLocal);
const Thread = py_callable(ThreadingThread);
const _handler$4 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$4);
    const fn = (..._a) => new Proxy({}, _handler$4);
    return new Proxy(fn, _handler$4);
  },
  apply() {
    return new Proxy({}, _handler$4);
  },
  construct() {
    return new Proxy({}, _handler$4);
  }
};
const _stub$5 = new Proxy({}, _handler$4);
const croniter = _stub$5.croniter;
function ConfigDict(opts = {}) {
  return { ...opts };
}
class BaseModel {
  constructor(data = {}) {
    Object.assign(this, data);
  }
  static model_validate(data) {
    return new this(data);
  }
}
function Field(defaultValue, opts = {}) {
  return { default: defaultValue, ...opts };
}
function create_model(name, fieldDefs = {}) {
  return class extends BaseModel {
    static {
      this.model_fields = fieldDefs;
    }
  };
}
const pydantic = { ConfigDict, BaseModel, Field, create_model };
exposeClassAttributes(BaseModel);
const _handler$3 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$3);
    const fn = (..._a) => new Proxy({}, _handler$3);
    return new Proxy(fn, _handler$3);
  },
  apply() {
    return new Proxy({}, _handler$3);
  },
  construct() {
    return new Proxy({}, _handler$3);
  }
};
const _stub$4 = new Proxy({}, _handler$3);
const get = _stub$4.get;
function isawaitable(value) {
  return value !== null && value !== void 0 && typeof value.then === "function";
}
function iscoroutinefunction(value) {
  return typeof value === "function" && value.constructor?.name === "AsyncFunction";
}
function getfile(value) {
  return String(value?.filename ?? value?.fileName ?? value?.name ?? "");
}
function isclass(value) {
  return typeof value === "function" && /^\s*class\s/.test(String(value));
}
function signature(_value) {
  throw new Error("inspect.signature is not implemented in this bundle");
}
function format_exception(...args) {
  const err = args.find((arg) => arg instanceof Error);
  if (err) {
    return [
      `${err.name}: ${err.message}`,
      ...err.stack ? err.stack.split("\n").slice(1) : []
    ];
  }
  return args.map((arg) => String(arg));
}
function format_exc() {
  return "";
}
function print_exception(..._args) {
}
function print_exc() {
}
const MODULE_ALIASES = {
  "langchain_openai": "@langchain/openai",
  "langchain_openai.chat_models": "@langchain/openai",
  "langchain_openai.chat_models.base": "@langchain/openai",
  "langchain_anthropic": "@langchain/anthropic",
  "langchain_community": "@langchain/community",
  "langchain_core": "@langchain/core",
  "langchain_google_genai": "@langchain/google-genai",
  "langchain_aws": "@langchain/aws",
  "openai": "openai"
};
function buildRequire() {
  const roots = [
    process.cwd()
  ];
  for (const root of roots) {
    const pkg = join(root, "package.json");
    if (existsSync(pkg)) {
      try {
        return createRequire(join(root, "package.json"));
      } catch (_) {
      }
    }
  }
  return createRequire(import.meta.url);
}
const req = buildRequire();
function import_module(name) {
  if (name == null)
    return null;
  const n = String(name);
  const candidates = [];
  if (MODULE_ALIASES[n])
    candidates.push(MODULE_ALIASES[n]);
  const parts = n.split(".");
  for (let i = parts.length; i >= 1; i--) {
    const key = parts.slice(0, i).join(".");
    if (MODULE_ALIASES[key])
      candidates.push(MODULE_ALIASES[key]);
  }
  candidates.push(n);
  candidates.push(n.replaceAll("_", "-"));
  const seen = /* @__PURE__ */ new Set();
  let lastErr;
  for (const spec of candidates) {
    if (seen.has(spec))
      continue;
    seen.add(spec);
    try {
      return req(spec);
    } catch (e) {
      lastErr = e;
    }
  }
  const err = lastErr || new Error("Cannot find module " + n);
  try {
    err.name = parts[0];
  } catch (_) {
  }
  throw err;
}
const importlib = { import_module };
const RENAMED = {
  model_name: "model",
  model: "model",
  temperature: "temperature",
  max_tokens: "maxTokens",
  top_p: "topP",
  presence_penalty: "presencePenalty",
  frequency_penalty: "frequencyPenalty",
  logit_bias: "logitBias",
  logprobs: "logprobs",
  top_logprobs: "topLogprobs",
  seed: "seed",
  stop: "stop",
  request_timeout: "timeout",
  max_retries: "maxRetries",
  reasoning: "reasoning",
  reasoning_effort: "reasoningEffort",
  verbosity: "verbosity",
  use_responses_api: "useResponsesApi",
  streaming: "streaming",
  stream_usage: "streamUsage",
  verbose: "verbose",
  openai_api_key: "apiKey",
  api_key: "apiKey"
};
const NESTED = {
  openai_api_base: "baseURL",
  base_url: "baseURL",
  openai_organization: "organization",
  organization: "organization"
};
const DROPPED = /* @__PURE__ */ new Set([
  "async_client",
  "root_async_client",
  "client",
  "http_client",
  "openai_proxy",
  "tiktoken_model_name"
]);
function is_set(value) {
  return value !== void 0 && value !== null && value !== "";
}
function translate_options(kwargs) {
  const options = {};
  const configuration = {};
  for (const [key, value] of Object.entries(kwargs ?? {})) {
    if (DROPPED.has(key) || !is_set(value)) {
      continue;
    }
    if (NESTED[key]) {
      configuration[NESTED[key]] = value;
      continue;
    }
    const renamed = RENAMED[key];
    if (renamed) {
      options[renamed] = value;
    }
  }
  if (!is_set(options.apiKey) && process.env.OPENAI_API_KEY) {
    options.apiKey = process.env.OPENAI_API_KEY;
  }
  if (!is_set(configuration.baseURL) && process.env.OPENAI_API_BASE) {
    configuration.baseURL = process.env.OPENAI_API_BASE;
  }
  if (Object.keys(configuration).length > 0) {
    options.configuration = configuration;
  }
  return options;
}
class PythonChatOpenAI extends ChatOpenAI {
  constructor(kwargs = {}) {
    super(translate_options(kwargs));
  }
}
exposeClassAttributes(PythonChatOpenAI);
function _make() {
  const _handler2 = {
    get(_t, prop) {
      if (prop === "__esModule")
        return true;
      if (prop === "then")
        return void 0;
      if (prop === "default")
        return new Proxy({}, _handler2);
      const fn = function(..._a) {
        return new Proxy({}, _handler2);
      };
      return new Proxy(fn, _handler2);
    },
    apply() {
      return new Proxy({}, _handler2);
    },
    construct() {
      return new Proxy({}, _handler2);
    }
  };
  return new Proxy({}, _handler2);
}
const _stub$3 = _make();
function Limits(...args) {
  return new Proxy({ args }, {});
}
function AsyncClient(...args) {
  return new Proxy({ args, aclose: async () => {
  } }, {});
}
function create_agent(opts = {}) {
  const { model, tools = [], middleware, checkpointer, system_prompt, systemPrompt } = opts;
  return createAgent({
    model,
    tools: tools || [],
    ...middleware != null ? { middleware } : {},
    ...checkpointer != null ? { checkpointer } : {},
    systemPrompt: systemPrompt ?? system_prompt
  });
}
const AgentMiddleware = class AgentMiddleware2 {
};
const langchain = { create_agent, AgentMiddleware };
function message_chunk_to_message(chunk) {
  if (chunk == null)
    return chunk;
  if (chunk instanceof AIMessage && !(chunk instanceof AIMessageChunk))
    return chunk;
  const msg = chunk;
  const content = msg.content;
  const extra = {};
  if (msg.tool_calls != null)
    extra.tool_calls = msg.tool_calls;
  if (msg.additional_kwargs != null)
    extra.additional_kwargs = msg.additional_kwargs;
  if (msg.response_metadata != null)
    extra.response_metadata = msg.response_metadata;
  if (msg.id != null)
    extra.id = msg.id;
  return new AIMessage({ content, ...extra });
}
function messages_to_dict(messages) {
  try {
    return mapChatMessagesToStoredMessages(messages);
  } catch (_) {
    return (messages || []).map((m) => {
      if (m && typeof m.toDict === "function")
        return m.toDict();
      if (m && typeof m.toJSON === "function")
        return m.toJSON();
      return { type: m?.constructor?.name, content: m?.content };
    });
  }
}
class ContextVar {
  constructor(name, opts = {}) {
    this.name = name;
    this._default = opts.default ?? null;
    this._value = this._default;
    this._stack = [];
  }
  get() {
    return this._value;
  }
  set(value) {
    const token = { prev: this._value };
    this._stack.push(token);
    this._value = value;
    return token;
  }
  reset(token) {
    if (token && "prev" in token)
      this._value = token.prev;
    else
      this._value = this._default;
  }
}
function copy_context() {
  return {
    run(fn, ...args) {
      return typeof fn === "function" ? fn(...args) : fn;
    }
  };
}
const contextvars = { ContextVar, copy_context };
exposeClassAttributes(ContextVar);
function loads(text) {
  if (typeof text !== "string") {
    throw new TypeError(`json_repair.loads() expected a string, got ${typeof text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
  }
  try {
    return JSON.parse(jsonrepair(text));
  } catch {
    return "";
  }
}
const _handler$2 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$2);
    const fn = (..._a) => new Proxy({}, _handler$2);
    return new Proxy(fn, _handler$2);
  },
  apply() {
    return new Proxy({}, _handler$2);
  },
  construct() {
    return new Proxy({}, _handler$2);
  }
};
const _stub$2 = new Proxy({}, _handler$2);
const gethostname = _stub$2.gethostname;
class ParseException extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseException";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class ParseSyntaxException extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseSyntaxException";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class StopAsyncIteration extends Error {
  constructor(message) {
    super(message);
    this.name = "StopAsyncIteration";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class ClientConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class RuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
exposeClassAttributes(ParseException);
exposeClassAttributes(ParseSyntaxException);
exposeClassAttributes(StopAsyncIteration);
exposeClassAttributes(ClientConnectionError);
exposeClassAttributes(RuntimeError);
const _handler$1 = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler$1);
    const fn = (..._a) => new Proxy({}, _handler$1);
    return new Proxy(fn, _handler$1);
  },
  apply() {
    return new Proxy({}, _handler$1);
  },
  construct() {
    return new Proxy({}, _handler$1);
  }
};
const _stub$1 = new Proxy({}, _handler$1);
const ClientSession = _stub$1.ClientSession;
const ClientTimeout = _stub$1.ClientTimeout;
class ClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
class ClientPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientPayloadError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
exposeClassAttributes(ClientError);
exposeClassAttributes(ClientPayloadError);
function dictConfig(_config) {
}
class PersistenceFactory {
  constructor(_options) {
    throw new Error("PersistenceFactory is not part of this bundle: leaf_common/persistence/factory/* is excluded in bundling/leaf_common_exclusions.txt.");
  }
}
exposeClassAttributes(PersistenceFactory);
const _handler = {
  get(_t, prop) {
    if (prop === "__esModule")
      return true;
    if (prop === "then")
      return void 0;
    if (prop === "default")
      return new Proxy({}, _handler);
    const fn = (..._a) => new Proxy({}, _handler);
    return new Proxy(fn, _handler);
  },
  apply() {
    return new Proxy({}, _handler);
  },
  construct() {
    return new Proxy({}, _handler);
  }
};
const _stub = new Proxy({}, _handler);
const EPIPE = _stub.EPIPE;
function Queue() {
  const buf = [];
  const waiters = [];
  const wake = () => {
    while (waiters.length && buf.length) {
      const w = waiters.shift();
      w(buf.shift());
    }
  };
  const async_q = {
    async get() {
      if (buf.length)
        return buf.shift();
      return new Promise((resolve) => waiters.push(resolve));
    },
    async put(item) {
      buf.push(item);
      wake();
    }
  };
  const sync_q = {
    get() {
      if (!buf.length)
        throw new Error("Queue empty");
      return buf.shift();
    },
    put(item) {
      buf.push(item);
      wake();
    }
  };
  return {
    async_q,
    sync_q,
    close() {
      buf.length = 0;
      waiters.length = 0;
    }
  };
}
const janus = { Queue };
export {
  AgentMiddleware,
  AsyncClient,
  BaseModel,
  BytesIO,
  ClientSession,
  ClientTimeout,
  ConfigDict,
  ContextVar,
  EPIPE,
  Event,
  Event$1,
  Field,
  Future,
  Limits,
  Lock,
  Lock$1,
  PersistenceFactory,
  ProcessPoolExecutor,
  PythonChatOpenAI,
  Queue,
  REGISTRIES_DIR,
  RuntimeError,
  SelectorEventLoop,
  StringIO,
  TOP_LEVEL_DIR,
  Task,
  Thread,
  ThreadPoolExecutor,
  TimeoutError$1 as TimeoutError,
  addLevelName,
  all_tasks,
  callable,
  contains,
  contextmanager,
  copy_context,
  cpu_count,
  create_agent,
  create_model,
  croniter,
  current_task,
  current_thread,
  deepcopy,
  dict,
  dictConfig,
  eager_task_factory,
  exc_info,
  format_exc,
  format_exception,
  fromTimestamp,
  frozenset,
  gather,
  get,
  getLogRecordFactory,
  get_context,
  get_deep_size,
  get_running_loop,
  getfile,
  gethostname,
  import_module,
  is_dict,
  is_instance_named,
  isawaitable,
  isclass,
  iscoroutinefunction,
  issubclass,
  len,
  loads,
  message_chunk_to_message,
  messages_to_dict,
  new_event_loop,
  next,
  nullcontext,
  open$1 as open,
  open as open$1,
  pathsep,
  run_coroutine_threadsafe,
  set,
  setLogRecordFactory,
  set_event_loop,
  signature,
  suppress,
  to_thread,
  wait_for
};
