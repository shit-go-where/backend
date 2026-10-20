/**
 * Floors in routing. Toilets on B2 and L5 of one mall share a coordinate, so straight-line distance
 * calls them equal; a floor change is really a lift or escalator ride. Pure.
 */
import { floorsBetween, levelOrder } from '../common/level.js';
import { WALK_DETOUR, WALK_SPEED_MS } from '../common/geo.js';

/** Each floor between the person and the toilet, when we know which floor they're on. */
export const SECONDS_PER_FLOOR = 40;
/** Unknown floor: most people are nearer the ground (and the street), so prefer toilets near it. */
export const SECONDS_PER_FLOOR_FROM_GROUND = 20;
/** levelOrder of the ground floor, L1. */
const GROUND = 1;
/** Deepest basement and highest floor a level can be; past them it is a typo ("999"), not a floor. */
export const LOWEST_LEVEL = -10;
export const HIGHEST_LEVEL = 50;

/** The person's floor as a levelOrder, or null when it isn't one or is out of range. */
export function userLevelOrder(userLevel: string | null | undefined): number | null {
  const o = levelOrder(userLevel);
  return o !== null && o >= LOWEST_LEVEL && o <= HIGHEST_LEVEL ? o : null;
}

/**
 * Extra seconds for a toilet's floor. `userLevel` is what they said ("B1", "level 3"), else null.
 * Zero when the toilet's floor is unknown: nothing to compare.
 */
export function floorSeconds(userLevel: string | null | undefined, toiletLevelOrder: number | null): number {
  if (toiletLevelOrder === null) return 0;
  const mine = userLevelOrder(userLevel);
  return mine !== null
    ? floorsBetween(mine, toiletLevelOrder) * SECONDS_PER_FLOOR
    : floorsBetween(GROUND, toiletLevelOrder) * SECONDS_PER_FLOOR_FROM_GROUND;
}

/** The straight-line metres that take as long to walk as `seconds` (inverse of estimateWalkSeconds). */
export function secondsAsStraightM(seconds: number): number {
  return (seconds * WALK_SPEED_MS) / WALK_DETOUR;
}

/** "On your level", "1 floor up", "2 floors down", from the person's level to the toilet's. */
export function floorReason(userLevel: string | null | undefined, toiletLevelOrder: number | null): string | null {
  const mine = userLevelOrder(userLevel);
  if (mine === null || toiletLevelOrder === null) return null;
  const n = floorsBetween(mine, toiletLevelOrder);
  if (n === 0) return 'On your level';
  const floors = n === 0.5 ? 'Half a floor' : `${n} floor${n === 1 ? '' : 's'}`;
  return `${floors} ${toiletLevelOrder > mine ? 'up' : 'down'}`;
}
