import fs from 'node:fs';
import sax from 'sax';

/**
 * Read-only parse of `Sandbox.sbc` metadata: identities, factions, the
 * identity->faction dictionary and the set of identities that actually belong
 * to a connected human player (AllPlayersData or a non-empty SteamId).
 *
 * The NPC/player decision is data-driven on purpose. Names are not a reliable
 * signal: this world has identities called "First Colonist" and "Space
 * Pirates" that never appear in AllPlayersData.
 */

export interface SaveIdentity {
  id: string;
  name: string;
  steamId: string | null;
}

export interface SaveFaction {
  id: string;
  tag: string;
  name: string;
  members: string[];
}

export interface SaveContext {
  identities: Map<string, SaveIdentity>;
  factions: Map<string, SaveFaction>;
  factionOfIdentity: Map<string, string>;
  realPlayers: Set<string>;
}

export function emptyContext(): SaveContext {
  return {
    identities: new Map(),
    factions: new Map(),
    factionOfIdentity: new Map(),
    realPlayers: new Set(),
  };
}

type Capture = { field: string; parts: string[] };

export function parseSaveContextStream(stream: NodeJS.ReadableStream): Promise<SaveContext> {
  return new Promise((resolve, reject) => {
    const parser = sax.parser(true, { trim: true, normalize: false });
    const ctx = emptyContext();
    const stack: string[] = [];
    const pending = new Map<number, Capture>();

    let identityDepth: number | null = null;
    let identity: SaveIdentity = { id: '', name: '', steamId: null };
    let factionDepth: number | null = null;
    let faction: SaveFaction = { id: '', tag: '', name: '', members: [] };
    let memberDepth: number | null = null;
    let memberId = '';
    let playersDepth: number | null = null;
    let itemDepth: number | null = null;
    let itemKey = '';
    let itemValue = '';
    let allPlayersDepth: number | null = null;

    const commit = (depth: number, field: string, value: string): void => {
      if (identityDepth !== null && depth === identityDepth + 1) {
        if (field === 'IdentityId') identity.id = value;
        else if (field === 'DisplayName') identity.name = value;
        else if (field === 'SteamId') identity.steamId = value || null;
        return;
      }
      if (factionDepth !== null && depth === factionDepth + 1) {
        if (field === 'FactionId') faction.id = value;
        else if (field === 'Tag') faction.tag = value;
        else if (field === 'Name') faction.name = value;
        return;
      }
      if (memberDepth !== null && depth === memberDepth + 1) {
        if (field === 'PlayerId') memberId = value;
        return;
      }
      if (itemDepth !== null && depth === itemDepth + 1) {
        if (field === 'Key') itemKey = value;
        else if (field === 'Value') itemValue = value;
      }
    };

    const isFieldTag = (name: string): boolean =>
      name === 'IdentityId' ||
      name === 'DisplayName' ||
      name === 'SteamId' ||
      name === 'FactionId' ||
      name === 'Tag' ||
      name === 'Name' ||
      name === 'PlayerId' ||
      name === 'Key' ||
      name === 'Value';

    parser.onopentag = (node) => {
      stack.push(node.name);
      const depth = stack.length;
      const name = node.name;

      if (name === 'MyObjectBuilder_Identity') {
        identityDepth = depth;
        identity = { id: '', name: '', steamId: null };
      } else if (name === 'MyObjectBuilder_Faction') {
        factionDepth = depth;
        faction = { id: '', tag: '', name: '', members: [] };
      } else if (name === 'MyObjectBuilder_FactionMember' && factionDepth !== null) {
        memberDepth = depth;
        memberId = '';
      } else if (name === 'Players') {
        playersDepth = depth;
      } else if (name === 'AllPlayersData') {
        allPlayersDepth = depth;
      } else if (
        name === 'item' &&
        playersDepth !== null &&
        depth === playersDepth + 2
      ) {
        itemDepth = depth;
        itemKey = '';
        itemValue = '';
      }

      // Capture direct value fields for whichever context is active.
      const isIdentityField = identityDepth !== null && depth === identityDepth + 1;
      const isFactionField = factionDepth !== null && depth === factionDepth + 1;
      const isMemberField = memberDepth !== null && depth === memberDepth + 1;
      const isItemField = itemDepth !== null && depth === itemDepth + 1;
      if (isFieldTag(name) && (isIdentityField || isFactionField || isMemberField || isItemField)) {
        pending.set(depth, { field: name, parts: [] });
      }

      if (
        allPlayersDepth !== null &&
        depth > allPlayersDepth &&
        name === 'IdentityId'
      ) {
        pending.set(depth, { field: '__realPlayer', parts: [] });
      }
    };

    parser.ontext = (text) => {
      const capture = pending.get(stack.length);
      if (capture) capture.parts.push(text);
    };
    parser.oncdata = parser.ontext as (text: string) => void;

    parser.onclosetag = () => {
      const depth = stack.length;
      const capture = pending.get(depth);
      if (capture) {
        const value = capture.parts.join('').trim();
        pending.delete(depth);
        if (capture.field === '__realPlayer') {
          if (value) ctx.realPlayers.add(value);
        } else {
          commit(depth, capture.field, value);
        }
      }

      if (memberDepth !== null && depth === memberDepth) {
        if (memberId) faction.members.push(memberId);
        memberDepth = null;
        memberId = '';
      } else if (itemDepth !== null && depth === itemDepth) {
        if (itemKey && itemValue) ctx.factionOfIdentity.set(itemKey, itemValue);
        itemDepth = null;
      } else if (factionDepth !== null && depth === factionDepth) {
        if (faction.id) ctx.factions.set(faction.id, faction);
        factionDepth = null;
      } else if (identityDepth !== null && depth === identityDepth) {
        if (identity.id) ctx.identities.set(identity.id, identity);
        identityDepth = null;
      } else if (playersDepth !== null && depth === playersDepth) {
        playersDepth = null;
      } else if (allPlayersDepth !== null && depth === allPlayersDepth) {
        allPlayersDepth = null;
      }
      stack.pop();
    };

    parser.onerror = (err) => {
      reject(err);
      parser.resume();
    };
    parser.onend = () => resolve(ctx);
    stream.on('data', (chunk) => parser.write((chunk as Buffer).toString('utf8')));
    stream.on('end', () => parser.close());
    stream.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
  });
}

export function loadSaveContext(sbcPath: string): Promise<SaveContext> {
  if (!fs.existsSync(sbcPath)) return Promise.resolve(emptyContext());
  return parseSaveContextStream(fs.createReadStream(sbcPath));
}

/** A real player has a SteamId or appears in AllPlayersData. */
export function isRealPlayer(ctx: SaveContext, identityId: string | null): boolean {
  if (!identityId) return false;
  if (ctx.realPlayers.has(identityId)) return true;
  const steamId = ctx.identities.get(identityId)?.steamId;
  return Boolean(steamId && steamId.trim() && steamId !== '0');
}
