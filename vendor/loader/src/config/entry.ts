import { composeError, Context, FiberState, Inject, Service, type Fiber } from '@deepseek-ai/cordis'
import { deepEqual, defineProperty, isNullable, isNonNullable, type Dict } from '@deepseek-ai/cosmokit'
import { ModuleLoader } from '../internal.ts'
import { evaluate, interpolate, isJsExpr } from './utils.ts'

/** Serialized plugin entry options stored in loader config files. */
export interface EntryOptions {
  /** Stable id inside the containing entry tree. */
  id: string
  /** Module specifier imported by the entry tree. */
  name: string
  /** Config passed to the plugin. */
  config?: any
  /** Marks this entry as a nested group. */
  group?: boolean | null
  /** Prevents this entry and descendants from running. */
  disabled?: boolean | null
  /** Required services or service intercept config for this entry. */
  inject?: Inject | null
  /** Service intercept config applied to this entry's context. */
  intercept?: Dict | null
  /** Service isolation config, keyed by service name. */
  isolate?: Dict<true | string> | null
}

function updateError(stage: 'import' | 'dispose' | 'apply' | 'rollback', options: EntryOptions, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}`, { cause })
}

function takeEntries(object: {}, keys: string[]) {
  const result: [string, any][] = []
  for (const key of keys) {
    if (!(key in object)) continue
    result.push([key, object[key]])
    delete object[key]
  }
  return result
}

function sortKeys<T extends {}>(object: T, prepend = ['id', 'name'], append = ['config']): T {
  const part1 = takeEntries(object, prepend)
  const part2 = takeEntries(object, append)
  const rest = takeEntries(object, Object.keys(object)).sort(([a], [b]) => a.localeCompare(b))
  return Object.assign(object, Object.fromEntries([...part1, ...rest, ...part2]))
}

function replaceKeys<T extends {}>(target: T, source: T): T {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key)
  return Object.assign(target, source)
}

/** One configured plugin node inside an `EntryTree`. */
export class Entry {
  static readonly key = Symbol.for('cordis.entry')

  public ctx: Context
  public fiber?: Fiber
  public parent!: EntryGroup
  // safety: call `entry.update()` immediately after creating an entry
  public options = {} as EntryOptions
  public subgroup?: EntryGroup
  public subtree?: EntryTree

  _initTask?: Promise<void>
  _disposing = 0

  constructor(public loader: Loader) {
    this.ctx = loader.ctx.extend({ [Entry.key]: this })
    this.context.emit('loader/entry-init', this)
  }

  get context(): Context {
    return this.ctx
  }

  get id() {
    let id = this.options.id
    if (this.parent.tree.ctx.fiber.entry) {
      id = this.parent.tree.ctx.fiber.entry.id + EntryTree.sep + id
    }
    return id
  }

  /** True when this entry or any owning parent entry is disabled. */
  get disabled() {
    return this._disabled(this.options)
  }

  private _disabled(options: EntryOptions) {
    // group is always enabled
    if (options.group) return false
    if (this.disabledOf(options)) return true
    let entry = this.parent.ctx.fiber.entry
    while (entry) {
      if (this.disabledOf(entry.options)) return true
      entry = entry.parent.ctx.fiber.entry
    }
    return false
  }

  /**
   * Effective disabled state: a `!!js` expression evaluates against the loader
   * context. The raw node stays in the options, so write-back keeps the form.
   */
  private disabledOf(options: EntryOptions): boolean {
    return isJsExpr(options.disabled)
      ? Boolean(this.evaluate(options.disabled.__jsExpr))
      : Boolean(options.disabled)
  }

  evaluate(expr: string) {
    return evaluate(this.ctx, expr)
  }

  private async _patchContext(diff: string[]) {
    await this.context.waterfall('loader/patch-context', this, async () => {
      Object.setPrototypeOf(this.ctx, this.parent.ctx)

      if (this.fiber?.uid && (diff.includes('config') || this.options.group)) {
        await this.fiber.update(this.options.config, true)
      }
    })
  }

  async refresh() {
    if (this.fiber) return
    if (this.disabled) return
    await this.init()
  }

  async _dispose(fiber = this.fiber) {
    if (!fiber) return
    if (this.fiber === fiber) this.fiber = undefined
    this._disposing += 1
    try {
      await fiber.dispose()
    } finally {
      this._disposing -= 1
    }
  }

  /** Merge new options, restart as needed, and persist through the parent tree. */
  async update(options: Partial<EntryOptions>, create = false, force = false) {
    const previousOptions = this.options
    const legacy = { ...previousOptions }
    const candidate = create ? options as EntryOptions : { ...previousOptions }
    if (!create) {
      for (const [key, value] of Object.entries(options)) {
        if (isNullable(value)) {
          delete candidate[key as keyof EntryOptions]
        } else {
          candidate[key as keyof EntryOptions] = value as never
        }
      }
    }
    sortKeys(candidate)

    const diff = Object
      .keys({ ...candidate, ...legacy })
      .filter(key => !deepEqual(candidate[key as keyof EntryOptions], legacy[key as keyof EntryOptions]))
    if (!diff.length && !force) return

    const commit = () => {
      if (create) return
      this.options = replaceKeys(previousOptions, candidate)
    }

    const previous = this.fiber
    if (!previous?.uid) {
      this.fiber = undefined
      this.options = candidate
      try {
        if (!this._disabled(candidate)) await this.init()
      } catch (error) {
        this.options = previousOptions
        throw error
      }
      commit()
      return
    }

    if (this._disabled(candidate)) {
      this.options = candidate
      try {
        await this._dispose(previous)
      } catch (error) {
        this.options = previousOptions
        throw updateError('dispose', candidate, error)
      }
      commit()
      this.context.emit('loader/partial-dispose', this, legacy, true)
      return
    }

    const replace = diff.some(key => key === 'name' || key === 'inject' || key === 'group')
    if (!replace) {
      this.options = candidate
      try {
        await this._patchContext(diff)
      } catch (error) {
        this.options = previousOptions
        try {
          await this._patchContext(diff)
        } catch (rollbackError) {
          throw updateError('rollback', legacy, new AggregateError([error, rollbackError]))
        }
        this.context.emit('loader/partial-dispose', this, candidate, true)
        throw updateError('apply', candidate, error)
      }
      commit()
      this.context.emit('loader/partial-dispose', this, legacy, true)
      return
    }

    let plugin: any
    try {
      plugin = diff.includes('name')
        ? this.loader.unwrapExports(await this.parent.tree.import(candidate.name, this.getOuterStack))
        : previous.runtime!.callback
    } catch (error) {
      throw updateError('import', candidate, error)
    }

    const previousPlugin = previous.runtime!.callback
    this.options = candidate
    try {
      await this._dispose(previous)
    } catch (error) {
      this.options = previousOptions
      throw updateError('dispose', candidate, error)
    }

    try {
      await this._start(plugin)
    } catch (error) {
      this.options = previousOptions
      try {
        await this._start(previousPlugin)
      } catch (rollbackError) {
        throw updateError('rollback', legacy, new AggregateError([error, rollbackError]))
      }
      this.context.emit('loader/partial-dispose', this, candidate, true)
      throw updateError('apply', candidate, error)
    }
    commit()
    this.context.emit('loader/partial-dispose', this, legacy, true)
  }

  getOuterStack = () => {
    let entry: Entry | undefined = this
    const result: string[] = []
    do {
      result.push(`    at ${entry.parent.tree.ctx.baseUrl}#${entry.options.id}`)
      entry = entry.parent.ctx.fiber.entry
    } while (entry)
    return result
  }

  /** Import and start the configured plugin if it is not already running. */
  async init() {
    try {
      await (this._initTask ??= this._init())
    } finally {
      this._initTask = undefined
      if (!this.loader.getTasks().length) this.ctx.reflect.notify(['loader'])
    }
    await this._await()
  }

  async _await() {
    try {
      await this.fiber?.await()
    } catch (error) {
      throw updateError('apply', this.options, error)
    }
  }

  private async _init() {
    let plugin: any
    try {
      plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack))
    } catch (error) {
      throw updateError('import', this.options, error)
    }
    try {
      await this._start(plugin)
    } catch (error) {
      throw updateError('apply', this.options, error)
    }
  }

  private async _start(plugin: any) {
    let fiber: Fiber | undefined
    try {
      await this._patchContext([])
      this.loader.showLog(this, 'apply')
      fiber = this.fiber = this.ctx.registry.plugin(plugin, this.options.config, this.getOuterStack)
      await fiber.await()
    } catch (error) {
      await this._dispose(fiber)
      throw error
    }
  }
}

export interface Entry {
  /** Entry-local realm assigned by the first isolated service access. */
  realm: LocalRealm
}

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const existing = this.tree.store[id]
    const entry: Entry = existing ?? (this.tree.store[id] = new Entry(this.ctx.loader))
    const previousParent = entry.parent
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    try {
      await entry.update(options, true, true)
    } catch (error) {
      if (existing) {
        entry.parent = previousParent
      } else {
        delete this.tree.store[id]
      }
      throw error
    }
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  async remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    await entry._dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    const seen = new Set<string>()
    for (const options of config) {
      const id = this.tree.ensureId(options)
      if (seen.has(id)) throw new TypeError(`duplicate loader entry id: ${id}`)
      seen.add(id)
    }
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id, options]))

    try {
      const outcomes = await Promise.allSettled(config.map(options => this.create(options)))
      // Disposal owns termination: sibling starts can still be settling after
      // the containing tree has gone away, but their failures no longer
      // describe a live update to roll back.
      if (this.ctx.fiber.uid === null) return
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(outcome => outcome.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'loader entries failed to apply')
      for (const id of Object.keys(oldMap)) {
        if (!newMap[id]) await this.remove(id, true)
      }
      this.data = config
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const id of Object.keys(newMap).reverse()) {
        if (oldMap[id]) continue
        try {
          await this.remove(id, true)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      for (const options of oldConfig) {
        try {
          await this.create(options)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      this.data = oldConfig
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'loader entry rollback failed')
      throw error
    }
  }

  async stop() {
    for (const options of this.data) {
      await this.remove(options.id, true)
    }
  }
}

/** Mutable tree of loader entries. Persistence is supplied by subclasses. */
export abstract class EntryTree {
  static readonly sep = ':'

  public ctx: Context
  public enableLogs?: boolean
  public root: EntryGroup
  public store: Dict<Entry> = Object.create(null)

  constructor(ctx: Context) {
    this.ctx = ctx.extend({ baseUrl: ctx.baseUrl })
    this.root = new EntryGroup(this.ctx, this)
    const entry = this.ctx.fiber.entry
    if (entry) entry.subtree = this
  }

  get context(): Context {
    return this.ctx
  }

  /** Iterate entries in this tree and any nested subtrees. */
  * entries(): Generator<Entry, void, void> {
    for (const entry of Object.values(this.store)) {
      yield entry
      if (!entry.subtree) continue
      yield* entry.subtree.entries()
    }
  }

  /** Return pending import and lifecycle tasks owned by this tree. */
  getTasks() {
    return [...this.entries()]
      .map(entry => entry._initTask || entry.fiber?.inertia)
      .filter(isNonNullable)
  }

  /**
   * Wait until this tree has no active import or lifecycle tasks.
   * @throws a settled fiber failure, or an aggregate when several fibers failed.
   */
  async await() {
    while (true) {
      const tasks = this.getTasks()
      if (tasks.length) {
        await Promise.allSettled(tasks)
        continue
      }
      const outcomes = await Promise.allSettled(
        [...this.entries()].map(entry => entry._await()),
      )
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map(outcome => outcome.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'loader fibers failed')
      this.ctx.reflect.notify(['loader'])
      if (!this.getTasks().length) return
    }
  }

  ensureId(options: Partial<EntryOptions>) {
    if (!options.id) {
      do {
        options.id = Math.random().toString(16).slice(2, 10)
      } while (this.store[options.id])
    }
    return options.id!
  }

  /** Resolve an entry by id, including nested ids separated by `EntryTree.sep`. */
  resolve(id: string) {
    const parts = id.split(EntryTree.sep)
    let tree: EntryTree | undefined = this
    const final = parts.pop()!
    for (const part of parts) {
      tree = tree.store[part]?.subtree
      if (!tree) throw new Error(`cannot resolve entry ${id}`)
    }
    const entry = tree.store[final]
    if (!entry) throw new Error(`cannot resolve entry ${id}`)
    return entry
  }

  resolveGroup(id: string | null) {
    if (!id) return this.root
    const entry = this.resolve(id)
    if (!entry.subgroup) throw new Error(`entry ${id} is not a group`)
    return entry.subgroup
  }

  /** Create an entry in the root group or a nested group. */
  async create(options: Omit<EntryOptions, 'id'>, parent: string | null = null, position = Infinity) {
    const group = this.resolveGroup(parent)
    const id = await group.create(options)
    const entry = this.resolve(id)
    group.data.splice(position, 0, entry.options)
    group.tree.write()
    return id
  }

  /** Stop and remove an entry from its parent group. */
  async remove(id: string) {
    const entry = this.resolve(id)
    await entry.parent.remove(id)
    entry.parent.tree.write()
  }

  /** Update an entry and optionally move it to another group. */
  async update(id: string, options: Omit<EntryOptions, 'id' | 'name'>, parent?: string | null, position?: number) {
    const entry = this.resolve(id)
    const source = entry.parent
    const sourceIndex = source.data.indexOf(entry.options)
    let target = source
    if (parent !== undefined) {
      target = this.resolveGroup(parent)
      source.unlink(entry.options)
      target.data.splice(position ?? Infinity, 0, entry.options)
      entry.parent = target
    }
    try {
      await entry.update(options, false, true)
    } catch (error) {
      if (parent !== undefined) {
        target.unlink(entry.options)
        source.data.splice(sourceIndex < 0 ? source.data.length : sourceIndex, 0, entry.options)
        entry.parent = source
        try {
          await entry.update({}, false, true)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back loader entry move ${id}`)
        }
      }
      throw error
    }
    source.tree.write()
    if (target !== source) target.tree.write()
  }

  /** Import a plugin module from a specifier or `cordis:` builtin. */
  import(name: string, getOuterStack?: () => string[]) {
    if (name.startsWith('cordis:')) {
      return this.ctx.loader.builtins[name.slice(7)]
    }
    return composeError(async (info) => {
      // ModuleJob.run
      // onImport.tracePromise.__proto__
      // internal.import
      info.offset += 3
      if (this.ctx.loader.internal) {
        return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
      } else if (name.startsWith('.')) {
        return await import(/* @vite-ignore */new URL(name, this.ctx.baseUrl).href)
      } else {
        return await import(/* @vite-ignore */name)
      }
    }, getOuterStack)
  }

  /** Persist current tree state. In-memory trees may implement this as a no-op. */
  abstract write(): void
}

function swap<T extends {}>(target: T, source?: T | null) {
  for (const key of Reflect.ownKeys(target)) {
    Reflect.deleteProperty(target, key)
  }
  for (const key of Reflect.ownKeys(source || {})) {
    Reflect.defineProperty(target, key, Reflect.getOwnPropertyDescriptor(source!, key)!)
  }
}

/** Symbol realm used to isolate service implementations by entry or label. */
export abstract class Realm {
  protected store: Dict<symbol> = Object.create(null)

  abstract get suffix(): string

  access(key: string, create = false) {
    if (create) {
      return this.store[key] ??= Symbol(`${key}${this.suffix}`)
    } else {
      return this.store[key] ?? Symbol(`${key}${this.suffix}`)
    }
  }

  delete(key: string) {
    delete this.store[key]
  }

  get size() {
    return Object.keys(this.store).length
  }
}

/** Entry-local isolation realm. */
export class LocalRealm extends Realm {
  constructor(private entry: Entry) {
    super()
  }

  get suffix() {
    return '#' + this.entry.options.id
  }
}

/** Named isolation realm shared by entries that use the same label. */
export class GlobalRealm extends Realm {
  constructor(public label: string) {
    super()
  }

  get suffix() {
    return '@' + this.label
  }
}

/** Install loader hooks that apply `intercept` and `isolate` entry options. */
export function isolate(ctx: Context) {
  const realms: Dict<GlobalRealm> = Object.create(null)
  const delims: Dict<symbol> = Object.create(null)

  function access(entry: Entry, name: string, create: true): symbol
  function access(entry: Entry, name: string, create?: boolean): symbol | undefined
  function access(entry: Entry, name: string, create = false) {
    let realm: Realm | undefined
    const label = entry.options.isolate?.[name]
    if (!label) return
    if (label === true) {
      realm = entry.realm ??= new LocalRealm(entry)
    } else if (create) {
      realm = realms[label] ??= new GlobalRealm(label)
    } else {
      realm = realms[label]
    }
    return realm?.access(name, create)
  }

  ctx.on('loader/entry-init', (entry) => {
    entry.ctx[Context.intercept] = Object.create(entry.ctx[Context.intercept])
    entry.ctx[Context.isolate] = Object.create(entry.ctx[Context.isolate])
  })

  ctx.on('loader/patch-context', async (entry, next) => {
    // step 1: generate new isolate map
    const newMap: Dict<symbol> = Object.create(entry.parent.ctx[Context.isolate])
    for (const name of Object.keys(entry.options.isolate ?? {})) {
      newMap[name] = access(entry, name, true)
    }

    // step 2: generate service diff
    const diff: Dict<[symbol, symbol, symbol, symbol]> = Object.create(null)
    const oldMap = entry.ctx[Context.isolate]
    for (const name in { ...newMap, ...delims }) {
      if (newMap[name] === oldMap[name]) continue
      const delim = delims[name] ??= Symbol(`delim:${name}`)
      entry.ctx[delim] = Symbol(`${name}#${entry.id}`)
      for (const symbol of [oldMap[name], newMap[name]]) {
        const impl = symbol && entry.ctx.reflect.store[symbol]
        if (!impl) continue
        if (!impl.fiber) {
          entry.ctx.logger.warn(new Error(`expected service ${name} to be implemented`))
          continue
        }
        diff[name] = [oldMap[name], newMap[name], entry.ctx[delim], impl.fiber.ctx[delim]]
        if (entry.ctx[delim] !== impl.fiber.ctx[delim]) break
      }
    }

    // step 3: set prototype for transferred context
    Object.setPrototypeOf(entry.ctx[Context.isolate], entry.parent.ctx[Context.isolate])
    Object.setPrototypeOf(entry.ctx[Context.intercept], entry.parent.ctx[Context.intercept])
    swap(entry.ctx[Context.isolate], newMap)
    swap(entry.ctx[Context.intercept], entry.options.intercept)

    // step 4: reload fiber
    await next()

    // step 5: replace service impl
    for (const [symbol1, symbol2, flag1, flag2] of Object.values(diff)) {
      if (flag1 === flag2 && entry.ctx.reflect.store[symbol1] && !entry.ctx.reflect.store[symbol2]) {
        entry.ctx.reflect.store[symbol2] = entry.ctx.reflect.store[symbol1]
        delete entry.ctx.reflect.store[symbol1]
      }
    }

    // step 6: reflect notify
    ctx.reflect.notify(Object.keys(diff), (ctx, name) => {
      const [symbol1, symbol2, flag1, flag2] = diff[name]
      const symbol3 = ctx[Context.isolate][name]
      const flag3 = ctx[delims[name]]
      return (symbol1 === symbol3 || symbol2 === symbol3) && (flag1 === flag3) !== (flag1 === flag2)
    })

    // step 7: clean up delimiters
    for (const name in delims) {
      if (!Reflect.ownKeys(newMap).includes(name)) {
        delete entry.ctx[delims[name]]
      }
    }
  })

  ctx.on('loader/partial-dispose', (entry, legacy, active) => {
    for (const [name, label] of Object.entries(legacy.isolate ?? {})) {
      if (label === true) continue
      if (active && entry.options.isolate?.[name] === label) continue
      const realm = realms[label]
      if (!realm) continue

      // realm garbage collection
      for (const entry of ctx.loader.entries()) {
        // has reference to this realm
        if (entry.options.isolate?.[name] === realm.label) return
      }
      realm.delete(name)
      if (!realm.size) {
        delete realms[realm.label]
      }
    }
  })
}

/** Loader config and dependency intercept namespace. */
export namespace Loader {
  /** Root loader configuration. */
  export interface Config {
    /** Base URL used to resolve relative plugin specifiers and config paths. */
    baseUrl?: string
  }

  /** Intercept config used when other plugins depend on `loader`. */
  export interface Intercept {
    /** Keep dependent plugins pending while loader entries are still loading. */
    await?: boolean
  }
}

/**
 * Service that owns a loader entry tree and imports configured plugins.
 *
 * Subclasses provide persistence by implementing `write()` on `EntryTree`.
 */
export class Loader extends EntryTree {
  declare [Service.config]: Loader.Intercept

  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public name = 'loader'
  public internal = ModuleLoader.fromInternal()

  public builtins: Dict<any> = Object.create(null)

  constructor(ctx: Context, public config: Loader.Config = {}) {
    super(ctx)
    if (config.baseUrl) {
      this.ctx.baseUrl = config.baseUrl
    }
    const self = this

    defineProperty(this, Service.tracker, {
      associate: 'loader',
      property: 'ctx',
      noShadow: true,
    })

    ctx.reflect.provide('loader', this, this[Service.check])

    ctx.on('internal/config', function (this: Fiber, _config, next) {
      const config = next()
      if (!this.entry || this.parent.fiber?.entry === this.entry) return config
      // Tree carriers (Group, Include) keep their configs literal: their
      // entry and patch lists hold other rows' configs, whose `!!js`
      // expressions belong to those rows' own fibers.
      const plugin = this.runtime?.callback as Record<PropertyKey, unknown> | undefined
      if (plugin?.[EntryGroup.key]) return config
      return interpolate(this.ctx, config)
    }, { global: true })

    ctx.on('internal/update', async function (config, noSave, next) {
      if (!this.entry || noSave || this.parent.fiber?.entry === this.entry) return next()
      await next()
      const unparse = this.runtime?.Config?.['simplify']
      this.entry.options.config = unparse ? unparse(config) : config
      this.entry.parent.tree.write()
    }, { global: true, prepend: true })

    ctx.on('internal/update', function (config, _, next) {
      if (!this.entry || this.parent.fiber?.entry === this.entry) return next()
      self.showLog(this.entry, 'reload')
      return next()
    }, { global: true })

    ctx.on('internal/plugin', (fiber) => {
      // 1. set `fiber.entry`
      if (fiber.parent[Entry.key] && !fiber.entry) {
        fiber.entry = fiber.parent[Entry.key]
        // FIXME merge config
        Inject.resolve(fiber.entry!.options.inject, fiber.inject)
      }

      // 2. handle self-dispose
      // We only care about `ctx.fiber.dispose()`, so we need to filter out other cases.

      // case 1: fiber is created
      if (fiber.uid) return

      // case 2: fiber is not tracked by loader
      if (!fiber.entry) return

      // case 3: fiber is a child plugin under the entry (not the entry's root fiber)
      if (fiber.parent.fiber?.entry === fiber.entry) return

      // case 4: fiber is disposed on behalf of plugin deletion (such as plugin hmr)
      // self-dispose: ctx.fiber.dispose() -> fiber / runtime dispose -> delete(plugin)
      // plugin hmr: delete(plugin) -> runtime dispose -> fiber dispose
      if (!ctx.registry.has(fiber.runtime!.callback)) return

      // case 5: the entry's tree is being disposed
      const treeOwner = fiber.entry.parent.tree.ctx.fiber
      if (!treeOwner.uid || treeOwner.state === FiberState.UNLOADING) return

      // case 6: Loader is replacing or removing this exact fiber
      if (fiber.entry._disposing) return

      this.showLog(fiber.entry, 'unload')

      // case 7: fiber is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (fiber.entry.disabled) return

      fiber.entry.options.disabled = true
      fiber.entry.parent.tree.write()
    })

    ctx.plugin(isolate)
  }

  write() {
    // Loader's root tree is in-memory; writes are no-ops.
  }

  [Service.check]() {
    const config: Loader.Intercept = Service.prototype[Service.resolveConfig].call(this)
    if (config.await && this.getTasks().length) return false
    return true
  }

  showLog(entry: Entry, type: string) {
    if (entry.options.group || !entry.parent.tree.enableLogs) return
    this.ctx.root.logger?.('loader').info('%s plugin %C', type, entry.options.name)
  }

  /** Return the loader entry id that owns `fiber`, if any. */
  locate(fiber = this.ctx.fiber) {
    while (1) {
      if (fiber.entry) return fiber.entry.id
      const next = fiber.parent.fiber
      if (fiber === next) return
      fiber = next
    }
  }

  /** Hook for hosts that can restart the process on full-reload requests. */
  exit() {
  }

  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}
