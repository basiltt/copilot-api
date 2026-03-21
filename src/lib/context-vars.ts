// Augment Hono's ContextVariableMap so c.set/c.get for "tokenCount" is type-safe
declare module "hono" {
  interface ContextVariableMap {
    tokenCount: number | undefined
  }
}

export {}
