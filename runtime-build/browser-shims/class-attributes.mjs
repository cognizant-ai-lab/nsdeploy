// Python class attributes for transpiled classes.
//
// In python an instance reads a class attribute through self (self.TYPE_LOOKUP,
// self.END_MESSAGE). The transpile turns class attributes into JS statics, which
// `this` does not see, so every such read comes back undefined. vite.config.mjs
// calls exposeClassAttributes() on each class the package exports, which makes
// the statics readable through instances the way python resolves them: subclasses
// inherit them, and assigning on an instance shadows the class value for that
// instance only.
// PORT BACK: emit ClassName.X (or this.constructor.X) for class-attribute reads in
// the transpiling source.
const SKIP = new Set(["length", "name", "prototype", "caller", "arguments"]);

export function exposeClassAttributes(cls) {
  if (typeof cls !== "function" || !cls.prototype) return;
  for (const key of Object.getOwnPropertyNames(cls)) {
    if (SKIP.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(cls, key);
    if (!descriptor || typeof descriptor.value === "function" || descriptor.get) continue;
    if (Object.prototype.hasOwnProperty.call(cls.prototype, key)) continue;
    Object.defineProperty(cls.prototype, key, {
      configurable: true,
      get() {
        return cls[key];
      },
      set(value) {
        Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true });
      },
    });
  }
}
