/**
 * Ownership policy for the LIVE (survival) instance.
 *
 * On the owner's shared multiplayer world a grid's role alone is not enough:
 * a MANAGED tag on somebody else's ship (or on an NPC/MES grid that copied the
 * tag) would still be an order sent to a grid he does not own. So on
 * `RTS_ENV=live` a non-OFF role additionally requires the grid's big owner to
 * be one of the configured owner identities (Steam ids), or a member of the
 * owner's faction - both read from the plugin (`list_tagged` returns
 * `owners` identity ids and `ownerFactions` tags) and resolved through the
 * existing identity/ownership reads.
 *
 * The policy is deliberately separate from `roles.ts` (which stays pure and
 * testable): this module turns env + observed identities into a small immutable
 * policy, and `roles.ts` applies it. Fails closed: a live grid with no known
 * owner identity is not ours.
 *
 * `RTS_OWNER_STEAM_IDS` is a comma-separated list and has NO default: an
 * unset or blank value means no grid is owned, and the backend says so at
 * startup. Set it to your own Steam id (and any co-owner's) to automate
 * anything. Identity ids are resolved from the players telemetry the plugin
 * already sends (or from the plugin `identity` read), never hard-coded here.
 */

/** Shipped default: nobody. Automation requires an explicit allow-list. */
export const DEFAULT_OWNER_STEAM_IDS: readonly string[] = [];

/** `RTS_ENV=live` is the owner's shared world (see demo/env.ts). */
export function isLiveInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RTS_ENV ?? '').trim().toLowerCase() === 'live';
}

/** Comma-separated Steam ids; unset or blank resolves to an empty list. */
export function parseOwnerSteamIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.RTS_OWNER_STEAM_IDS ?? '').trim();
  const listed = (raw ? raw.split(',') : [...DEFAULT_OWNER_STEAM_IDS])
    .map((s) => s.trim())
    .filter((s) => /^[0-9]{6,20}$/.test(s));
  return [...new Set(listed)];
}

export interface OwnerPolicy {
  live: boolean;
  /** Configured owner Steam ids (the allow-list, for the audit/tooltip). */
  steamIds: string[];
  /** Identity ids resolved from those Steam ids: "you" on the grid rows. */
  identityIds: ReadonlySet<string>;
  /** Faction tags those identities belong to: "your faction". */
  factionTags: ReadonlySet<string>;
}

/** What the backend can resolve about a Steam id from existing reads. */
export interface OwnerIdentityLookup {
  identityForSteam(steamId: string): string | null;
  factionTagForSteam(steamId: string): string | null;
}

/** Build one immutable policy from the env and the resolved identities. */
export function buildOwnerPolicy(
  env: NodeJS.ProcessEnv,
  lookup: OwnerIdentityLookup,
  extra: { identityIds?: readonly string[]; factionTags?: readonly string[] } = {},
): OwnerPolicy {
  const steamIds = parseOwnerSteamIds(env);
  const identityIds = new Set<string>(extra.identityIds ?? []);
  const factionTags = new Set<string>();
  for (const steamId of steamIds) {
    const identity = lookup.identityForSteam(steamId);
    if (identity) identityIds.add(identity);
    const faction = lookup.factionTagForSteam(steamId);
    if (faction) factionTags.add(faction.toUpperCase());
  }
  for (const tag of extra.factionTags ?? []) factionTags.add(tag.toUpperCase());
  return { live: isLiveInstance(env), steamIds, identityIds, factionTags };
}

export interface OwnershipVerdict {
  /** True when the grid may carry a non-OFF role. */
  owned: boolean;
  /** Plain sentence for the role resolution / audit; never a stack trace. */
  detail: string;
}

/**
 * Is this grid ours? On the test instance ownership is not re-decided here
 * (the provisioner keeps its existing owner-identity rule), so it returns true.
 * On the live instance it fails closed: no policy, no owners, or an owner that
 * is neither a configured identity nor in the owner's faction is not ours.
 */
export function ownershipVerdict(
  owners: readonly (string | null | undefined)[] | null | undefined,
  ownerFactions: readonly (string | null | undefined)[] | null | undefined,
  policy: OwnerPolicy | null | undefined,
  live: boolean = policy?.live ?? false,
): OwnershipVerdict {
  if (!live) return { owned: true, detail: 'ownership applies on the live instance only' };
  if (!policy) return { owned: false, detail: 'no ownership policy is configured: no grid is assumed to be yours' };
  const ids = (owners ?? []).filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return { owned: false, detail: 'the grid reports no big owner' };
  if (policy.identityIds.size === 0 && policy.factionTags.size === 0) {
    return {
      owned: false,
      detail: `no identity is known for the configured owner Steam id(s) ${policy.steamIds.join(', ')}`,
    };
  }
  for (const id of ids) if (policy.identityIds.has(id)) return { owned: true, detail: `big owner ${id} is you` };
  const tags = (ownerFactions ?? [])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((t) => t.toUpperCase());
  for (const tag of tags) {
    if (policy.factionTags.has(tag)) return { owned: true, detail: `big owner is in your faction [${tag}]` };
  }
  return {
    owned: false,
    detail: `big owner ${ids[0]} is not you or your faction (owner Steam id(s) ${policy.steamIds.join(', ')})`,
  };
}
