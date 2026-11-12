import { z } from 'zod';
import { EpochMs, IdString, ResourceMap, SchemaVersion } from './common.js';

/**
 * Everything the RTS does is a mission and lives in one queue.
 * Hard rule: every mission has a budget and a loss limit; approval defaults
 * to `approve` and only becomes `auto` when an operator explicitly allows it
 * for that mission type (the shipped default config allows none).
 */
export const MissionType = z.enum([
  'build_deploy',
  'move',
  'cover',
  'patrol',
  'strike',
  'logistics',
  'repair',
  'scout',
  'replace',
]);
export type MissionType = z.infer<typeof MissionType>;

export const ApprovalMode = z.enum(['approve', 'auto']);
export const MissionStatus = z.enum([
  'queued',
  'planned',
  'approved',
  'executing',
  'paused',
  'done',
  'failed',
  'cancelled',
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const TERMINAL_STATUSES: MissionStatus[] = ['done', 'failed', 'cancelled'];
export const OPEN_STATUSES: MissionStatus[] = ['queued', 'planned', 'approved', 'executing', 'paused'];

export const FormationShape = z.enum(['ring', 'line', 'wedge', 'grid', 'none']);

export const DesiredState = z.object({
  shipSpec: IdString,
  station: IdString,
  formation: FormationShape.default('none'),
  /** How many units of this spec belong at the station. Additive field. */
  qty: z.number().int().positive().max(500).default(1),
  /** Optional target point for move/cover/patrol style missions. */
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  /**
   * Planet and altitude an application carries with the target (the survival
   * loop's return/relaunch sends both). They were stripped for lack of a
   * declaration, so the executor's `desiredState.planet` was always undefined
   * and every mission fell back to inferring the body from the point. Optional
   * and additive: nothing else changes.
   */
  planet: z.string().min(1).max(120).optional(),
  altitudeM: z.number().finite().optional(),
  /**
   * Landing mode (owner request, 2026-11-10): the ship lands ON the ground at
   * its slot instead of holding in the air.
   *
   *   land: true                      — land at the slot (flare 40 m)
   *   mode: 'land'                    — same, as a word
   *   landing: { flareAglM }          — land with an explicit flare height
   *
   * A bare `altitudeM: 0` is NOT read as a landing: it is refused by the ground
   * datum rule and an operator has to ask for a landing explicitly (a surprise
   * fall to the ground is how SAT-R-0002 was destroyed).
   */
  land: z.boolean().optional(),
  /**
   * `park` (owner request: "go to XYZ and park"): stop at the requested point.
   * A point on the ground lands; an airborne point is held in the air and the
   * executor's audit says which it did. `mode: 'hold'` is the ordinary hold.
   */
  park: z.boolean().optional(),
  mode: z.enum(['land', 'hold', 'park']).optional(),
  landing: z.object({ flareAglM: z.number().min(40).max(2_000).optional() }).optional(),
  /**
   * Ship roles (owner decision 2026-11-11): the owner confirmed an explicit
   * order for a PERSONAL (owner-marked) ship. Without it every order to that
   * grid is refused with 409; with it only the allowed owner flight actions
   * (go-to, come-to-me, land/park, return home, stop/brake/hold) are sent.
   * Declared here because the schema strips unknown desiredState keys.
   */
  personalConfirmed: z.boolean().optional(),
  /**
   * Come to me (owner request 2026-11-11): fly low and near a player, hold
   * there and wait for them to land it by hand with Remote Control. The
   * mission never lands or leaves on its own.
   *
   * `phase` is the progress the executor writes back: `flying` until the
   * hover point is reached, then `waiting_for_pilot` (hovering, dampeners on,
   * autopilot off, no further orders). `readyAt` is when the hover began, so
   * the alerts engine can raise the timeout alert from data alone.
   *
   * The schema strips unknown keys, so every field the route/executor exchange
   * has to be declared here (the same lesson as `adminOverride`).
   */
  comeToMe: z
    .object({
      /** The player's identityId or steamId; null when a stand-in point was used. */
      player: z.string().max(64).nullable().optional(),
      playerName: z.string().max(120).nullable().optional(),
      /** The stand-in point a GPS target supplied instead of a live player. */
      standIn: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      standoff: z.object({ lateralM: z.number(), aboveGroundM: z.number() }).optional(),
      /** The hover point handed to the executor (position for the hull bottom AGL). */
      hover: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      /** HULL-BOTTOM height above the true ground at the hover column, m. */
      hoverAglM: z.number().nullable().optional(),
      /** Where the ground radius came from: terrain level, or 'mean'. */
      groundSource: z.string().max(32).optional(),
      /**
       * The true ground radius at the hover column when the point was built, m
       * (2026-11-11). The hold guard judges the slot on THIS datum when its own
       * sample of the column is coarser, so a level-0 fallback can never refuse
       * a hover that was planned on level-5.
       */
      groundRadiusM: z.number().nullable().optional(),
      /**
       * Tile level behind `groundRadiusM` (5 = finest, 0 = the planning field),
       * so the executor knows whether the recorded datum is LANDING GRADE
       * without parsing the source string (2026-11-11).
       */
      groundLevel: z.number().nullable().optional(),
      /** 3D distance from the hover point to the player/stand-in point, m. */
      distanceToPlayerM: z.number().nullable().optional(),
      phase: z.enum(['flying', 'waiting_for_pilot', 'handed_to_pilot', 'timed_out']).optional(),
      /** Backend clock when the hover started (phase waiting_for_pilot). */
      readyAt: z.number().optional(),
      /** The mission's own timeout (default 10 min); stable if config changes. */
      timeoutMs: z.number().optional(),
    })
    .optional(),
});
export type DesiredState = z.infer<typeof DesiredState>;

export const MissionBudget = z.object({
  resources: ResourceMap.default({}),
  timeMin: z.number().positive().max(60 * 24 * 30),
  lossLimit: z.number().int().nonnegative().max(500),
  /** Optional hard cap on units this mission may build/dispatch. */
  maxUnits: z.number().int().positive().max(500).optional(),
});
export type MissionBudget = z.infer<typeof MissionBudget>;

export const MissionStep = z.object({
  id: IdString,
  kind: z.enum([
    'validate_spec',
    'reserve_materials',
    'print',
    'undock',
    'move',
    'dock',
    'link',
    'hold',
    'repair',
    'custom',
  ]),
  params: z.record(z.string(), z.unknown()).default({}),
  done: z.boolean().default(false),
});

export const MissionPlan = z.object({
  steps: z.array(MissionStep).default([]),
  notes: z.string().max(4000).optional(),
});

const missionShape = {
  schemaVersion: SchemaVersion,
  id: IdString,
  type: MissionType,
  priority: z.number().int().min(0).max(100).default(50),
  desiredState: DesiredState,
  budget: MissionBudget,
  approval: ApprovalMode.default('approve'),
  status: MissionStatus.default('queued'),
  assignedUnits: z.array(IdString).default([]),
  plan: MissionPlan.default({ steps: [] }),
  /** Deterministic key that makes mission creation idempotent. */
  idempotencyKey: z.string().min(1).max(256).optional(),
  /** Why the mission is paused, when status === 'paused'. */
  pauseReason: z.string().max(500).optional(),
  /** Written when a rule blocks dispatch (e.g. repair_pending). */
  blockedBy: z.string().max(100).optional(),
  createdBy: z.string().max(128).default('system'),
  createdAt: EpochMs,
  updatedAt: EpochMs,
};

export const MissionSchema = z.object(missionShape);
export type Mission = z.infer<typeof MissionSchema>;
export type MissionInput = z.input<typeof MissionSchema>;

/** API input: server fills id, timestamps and default status. */
export const MissionCreateSchema = z.object({
  ...missionShape,
  id: IdString.optional(),
  schemaVersion: SchemaVersion.default(1),
  status: MissionStatus.default('queued'),
  createdAt: EpochMs.optional(),
  updatedAt: EpochMs.optional(),
});
export type MissionCreate = z.input<typeof MissionCreateSchema>;

/** PATCH /api/missions/:id body. */
export const MissionPatchSchema = z
  .object({
    action: z.enum(['approve', 'cancel', 'pause', 'resume']).optional(),
    status: MissionStatus.optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => v.action !== undefined || v.status !== undefined, {
    message: 'action or status is required',
  });
