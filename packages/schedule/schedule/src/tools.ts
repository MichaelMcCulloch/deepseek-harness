/**
 * The Schedule tools' model-facing schemas, descriptions, and argument
 * validation, shared by the service that registers them.
 * @module @deepseek-ai/dsh-schedule
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, REQUIRED_TITLE_MESSAGE, ScheduleInputError } from './domain.ts'
import type {
  AtInput, CronInput, DailyInput, WeeklyInput, InternalScheduleError, ScheduleTimingChange, ScheduleToolError,
} from './types.ts'

/** Properties every reminder view carries, spread into the six kind schemas below. */
export const SHARED_VIEW_PROPERTIES = {
  id: { type: 'string', required: true },
  title: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  scheduledAt: { type: 'string', required: true },
  state: { type: 'string', required: true, enum: ['scheduled', 'overdue'] },
  deliveryMode: { type: 'string', required: true, const: 'host' },
} as const

/** Output schema for a reminder that fires a fixed delay after it is created. */
export const AFTER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'after' },
    afterSeconds: { type: 'integer', required: true },
  },
} as const

/** Output schema for a reminder with an absolute target instant. */
export const AT_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'at' },
  },
} as const

/** Output schema for a fixed-rate reminder. */
export const EVERY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'every' },
    everySeconds: { type: 'integer', required: true },
  },
} as const

/** Output schema for a reminder that repeats every day at a local time. */
export const DAILY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'daily' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

/** Output schema for a reminder that repeats weekly on the given ISO weekdays. */
export const WEEKLY_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'weekly' },
    time: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
    weekdays: { type: 'array', required: true, items: { type: 'integer' } },
  },
} as const

/** Output schema for a reminder driven by a five-field cron expression. */
export const CRON_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SHARED_VIEW_PROPERTIES,
    kind: { type: 'string', required: true, const: 'cron' },
    expression: { type: 'string', required: true },
    timeZone: { type: 'string', required: true },
  },
} as const

/** Output schema matching a reminder view of any one kind. */
export const VIEW_SCHEMA = {
  oneOf: [
    AFTER_VIEW_SCHEMA, AT_VIEW_SCHEMA, EVERY_VIEW_SCHEMA, DAILY_VIEW_SCHEMA, WEEKLY_VIEW_SCHEMA, CRON_VIEW_SCHEMA,
  ],
} as const

/** Build one exact two-field error schema while preserving its literal code. */
function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('invalid_time_zone'),
  basicErrorSchema('not_future'),
  basicErrorSchema('time_out_of_range'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('internal_error'),
] as const

/** `schedule_create` output: a reminder view or one of the canonical errors. */
export const CREATE_OUTPUT_SCHEMA = { oneOf: [VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const

/** `schedule_list` output: the active reminder views or one of the canonical errors. */
export const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: VIEW_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const
/** `schedule_delete` output: the per-id deletion result or one of the canonical errors. */
export const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: false },
        code: { type: 'string', required: true, const: 'schedule_not_found' },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

/** `schedule_update` output: the updated view, a per-id update refusal, or one of the canonical errors. */
export const UPDATE_OUTPUT_SCHEMA = {
  oneOf: [
    VIEW_SCHEMA,
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        updated: { type: 'boolean', required: true, const: false },
        code: {
          type: 'string',
          required: true,
          enum: ['schedule_not_found', 'schedule_ended', 'schedule_conflict'],
        },
      },
    },
    ...ERROR_SCHEMAS,
  ],
} as const

/** Model-facing description of `schedule_create`. */
export const CREATE_DESCRIPTION =
  'Create a reminder in the current session that delivers prompt when it becomes due. '
  + 'Supply exactly one timing parameter: after_seconds, at, every_seconds, daily, weekly, or cron. '
  + 'Local times that do not exist in the zone are skipped; repeated local times fire once, at the earlier instant. '
  + 'After downtime, a recurring reminder delivers only its latest missed occurrence. Delivery can repeat after a crash.'

/** Model-facing description of `schedule_list`. */
export const LIST_DESCRIPTION = 'List the active reminders in the current session.'

/** Model-facing description of `schedule_delete`. */
export const DELETE_DESCRIPTION =
  'Delete a reminder in the current session, active or inactive. Deletion does not retract a reminder message that is already queued.'

/** Model-facing description of `schedule_update`. */
export const UPDATE_DESCRIPTION =
  'Change a reminder in place, keeping its id. Supply a new title, prompt, or at most one timing parameter; '
  + 'omitted fields keep their stored values. To change a relative delay, create a new reminder.'

/**
 * Deterministic model content for every canonical Schedule value.
 * @param _args - Tool arguments, unused because rendering needs only the validated value.
 * @param value - Result value already validated against the tool's output schema.
 * @returns One text block carrying the value as JSON.
 */
export function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  const text = JSON.stringify(value)
  return [{ type: 'text', text }]
}

/**
 * Pure generic pending card.
 * @param title - Card title naming the pending operation.
 * @param kind - Card kind the client treats as read-only or otherwise.
 * @param rawInput - Optional tool arguments to show while the call is pending.
 * @returns The pending call view the ToolRuntime presents.
 */
export function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Stable error for failures not safe to expose.
 * @returns The `internal_error` result carrying the fixed model-facing message.
 */
export function internalError(): InternalScheduleError {
  return { code: 'internal_error', message: 'The schedule operation failed.' }
}

/**
 * Translate invalid input while withholding internal storage failures.
 * @param error - Rejection from a Schedule service call.
 * @returns The input's own code and message, or `internal_error` for anything else.
 */
export function operationError(error: unknown): ScheduleToolError {
  return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : internalError()
}

/**
 * One supplied fixed-rate interval: a safe integer at or above the Host floor, or undefined.
 * @param everySeconds - Interval from the request, absent when the request supplies another selector.
 * @returns The rejection for an out-of-range interval, otherwise undefined.
 */
export function invalidInterval(everySeconds: number | undefined): ScheduleToolError | undefined {
  if (everySeconds === undefined) return undefined
  if (!Number.isSafeInteger(everySeconds)) {
    return { code: 'invalid_rule', message: 'every_seconds must be a safe integer.' }
  }
  if (everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return {
      code: 'frequency_too_high',
      message: `every_seconds must be at least ${MIN_EVERY_INTERVAL_SECONDS}.`,
    }
  }
  return undefined
}

/**
 * Validate selector constraints that the open parameter root cannot express.
 * @param args - `schedule_create` arguments after ToolRuntime parameter validation.
 * @returns The rejection for an unknown key, a selector count other than one, or a bad name or interval; otherwise undefined.
 */
export function validateCreateArgs(args: {
  prompt: string
  title: string
  after_seconds?: number
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const keys = Object.keys(args)
  if (keys.some(key => key !== 'prompt'
    && key !== 'title'
    && key !== 'after_seconds'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || Number(args.after_seconds !== undefined)
    + Number(args.at !== undefined)
    + Number(args.every_seconds !== undefined)
    + Number(args.daily !== undefined)
    + Number(args.weekly !== undefined)
    + Number(args.cron !== undefined) !== 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_create accepts exactly one of after_seconds, at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  if (args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.after_seconds !== undefined
    && (!Number.isSafeInteger(args.after_seconds) || args.after_seconds <= 0)) {
    return { code: 'invalid_rule', message: 'after_seconds must be a positive safe integer.' }
  }
  return invalidInterval(args.every_seconds)
}

/**
 * Validate the in-place update's selector count, id, and any supplied name, instruction, or interval.
 * @param args - `schedule_update` arguments after ToolRuntime parameter validation.
 * @returns The rejection for an unknown key, extra selectors, a bare id, or an empty name or instruction; otherwise undefined.
 */
export function validateUpdateArgs(args: {
  id: string
  title?: string
  prompt?: string
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleToolError | undefined {
  const selectors = [
    args.at !== undefined,
    args.every_seconds !== undefined,
    args.daily !== undefined,
    args.weekly !== undefined,
    args.cron !== undefined,
  ].filter(Boolean).length
  if (Object.keys(args).some(key => key !== 'id'
    && key !== 'title'
    && key !== 'prompt'
    && key !== 'at'
    && key !== 'every_seconds'
    && key !== 'daily'
    && key !== 'weekly'
    && key !== 'cron')
    || selectors > 1) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update accepts at most one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.id.length === 0 || args.id.trim() !== args.id) {
    return { code: 'invalid_rule', message: 'schedule_update id must be non-empty without surrounding whitespace.' }
  }
  if (selectors === 0 && args.title === undefined && args.prompt === undefined) {
    return {
      code: 'invalid_selector',
      message: 'schedule_update needs a new title, prompt, or one of at, every_seconds, daily, weekly, or cron.',
    }
  }
  if (args.title !== undefined && args.title.trim().length === 0) {
    return { code: 'invalid_prompt', message: REQUIRED_TITLE_MESSAGE }
  }
  if (args.title !== undefined && args.title.trim().length > MAX_TITLE_LENGTH) {
    return { code: 'invalid_prompt', message: `title must be at most ${MAX_TITLE_LENGTH} characters.` }
  }
  if (args.prompt !== undefined && args.prompt.trim().length === 0) {
    return { code: 'invalid_prompt', message: 'prompt must be non-empty after trimming.' }
  }
  return invalidInterval(args.every_seconds)
}

/**
 * The one timing replacement the update carries, or undefined when the request keeps the committed target.
 * @param args - `schedule_update` arguments already accepted by {@link validateUpdateArgs}.
 * @returns The single supplied timing replacement, otherwise undefined.
 */
export function timingChangeFrom(args: {
  at?: AtInput
  every_seconds?: number
  daily?: DailyInput
  weekly?: WeeklyInput
  cron?: CronInput
}): ScheduleTimingChange | undefined {
  if (args.at !== undefined) return { kind: 'at', at: args.at }
  if (args.every_seconds !== undefined) return { kind: 'every', every_seconds: args.every_seconds }
  if (args.daily !== undefined) return { kind: 'daily', daily: args.daily }
  if (args.weekly !== undefined) return { kind: 'weekly', weekly: args.weekly }
  if (args.cron !== undefined) return { kind: 'cron', cron: args.cron }
  return undefined
}

/**
 * Selector parameters shared by `schedule_create` and `schedule_update`, in the order the
 * generated tool catalog states them.
 */
export const SELECTOR_PARAMETERS = {
  every_seconds: {
    type: 'number',
    description: `Fixed-rate interval in whole seconds, at least ${MIN_EVERY_INTERVAL_SECONDS}, aligned to the creation time; changing it with schedule_update re-aligns it to the save time.`,
  },
  daily: {
    type: 'object',
    additionalProperties: false,
    description: 'Every day at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  weekly: {
    type: 'object',
    additionalProperties: false,
    description: 'On the given weekdays at a local time.',
    properties: {
      time: { type: 'string', required: true, description: 'HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00.' },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
      weekdays: {
        type: 'array',
        required: true,
        description: 'ISO weekdays, Monday 1 through Sunday 7, without repetitions.',
        items: { type: 'integer' },
      },
    },
  },
  cron: {
    type: 'object',
    additionalProperties: false,
    description: 'Five-field Vixie cron expression in a time zone.',
    properties: {
      expression: {
        type: 'string',
        required: true,
        description: 'minute hour day-of-month month day-of-week, for example "*/15 9-17 * * 1-5". '
          + 'When both day fields are restricted, a date matches if either one matches.',
      },
      time_zone: { type: 'string', required: true, description: 'UTC or IANA Area/Location, for example Asia/Shanghai.' },
    },
  },
  at: {
    description: 'Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          date: { type: 'string', required: true },
          time: { type: 'string', required: true },
          time_zone: { type: 'string', required: true },
        },
      },
    ],
  },
} as const
