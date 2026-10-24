/**
 * Display-ready survey rows (API `Survey`, API_CONTRACT.md), so the frontend never needs to know the rubric.
 * Pure: no Prisma client, no Nest.
 *
 * PILOT_50 (March 2024 pilot, men's toilets): every item is a scale read from the Survey columns
 * (cleanliness 0-10, scent / aesthetics / music / toiletries 0-5, facilities 0-20, total /50).
 *
 * EXPANDED_2024 (Aug-Oct 2024 survey): `Survey.cleanliness` holds the 0-10 normalised value
 * ((c + 3) / 6 * 10), the pilot columns are null, and the importer writes the native values to
 * `Survey.breakdown` in exactly this shape (`ExpandedBreakdownSchema`):
 *
 *   {
 *     "cleanliness": -2,                                   // integer -3..+3, as rated
 *     "scent": 0,                                          // integer -2..+2, as rated
 *     "reasons": ["Toilets are free of chokage.", ...],    // ticked EXPANDED_REASONS
 *     "toiletries": ["Toilet Paper", "Hand Soap"],         // ticked EXPANDED_TOILETRIES
 *     "facilities": ["Mirrors functional", ...]            // ticked EXPANDED_FACILITIES
 *   }
 *
 * Checklist arrays hold the item text verbatim from the lists below (match the sheet case-insensitively,
 * store the canonical spelling), each item at most once, any order, never "None of the Above". Free text
 * from the reasons "Others" box is not a checklist item: it goes in `Survey.remarks`.
 */
import { z } from 'zod';
import type { SurveyRubric, SurveySex } from '../generated/prisma/enums.js';

/** Sheet text -> label shown in the app. Order is display order; the list length is the checklist total. */
type Checklist = readonly (readonly [native: string, label: string])[];

export const EXPANDED_REASONS = [
  ['General appearance of toilet looks stain-free. (floor, walls, wall tiles, ceiling, cubicle doors)', 'No stains on floor, walls or doors'],
  ['Floor is free of litter/little presence of litter', 'Little or no litter'],
  ['Hand wash area is clean and tidy.', 'Clean, tidy sinks'],
  ['Toilet bowl seat and cover/squat pan is intact and stain-free.', 'Seat or squat pan intact and clean'],
  ['Toilets are free of chokage.', 'No choked toilets'],
  ['[Female] Sanitary bin is clean, intact and lined with plastic bag.', 'Sanitary bin clean and lined'],
] as const satisfies Checklist;

export const EXPANDED_TOILETRIES = [
  ['Toilet Paper', 'Toilet paper'],
  ['Hand Towel', 'Hand towel'],
  ['Hand Dryer', 'Hand dryer'],
  ['Hand Soap', 'Hand soap'],
  ['Toilet liner/Seat cleaner', 'Seat liner or cleaner'],
] as const satisfies Checklist;

export const EXPANDED_FACILITIES = [
  ['Mirrors functional', 'Mirrors work'],
  ['Taps functional', 'Taps work'],
  ['Urinals functional', 'Urinals work'],
  ['Toilets functional', 'Toilets work'],
  ['Door locks functional', 'Door locks work'],
  ['Bidet available', 'Bidet'],
  ['Functional automatic flush', 'Auto flush'],
  ['Automatic tap', 'Auto tap'],
  ['Automatic soap dispenser', 'Auto soap'],
  ['Rubbish bin not full', 'Bin not full'],
  ['Feedback form or device available', 'Feedback device'],
  ['Ambulant facilities available (larger stalls with handrails)', 'Ambulant stall'],
  ['Child facilities available', 'Child facilities'],
  ['Nursing Room Available', 'Nursing room'],
  ['Handicapped Facilities Available', 'Accessible toilet'],
] as const satisfies Checklist;

/** Ticked items of one checklist: canonical item text only, each at most once. */
function checklist(list: Checklist) {
  const known = new Set(list.map(([n]) => n));
  return z
    .array(z.string().refine((x) => known.has(x), { message: 'not an item of this checklist' }))
    .refine((xs) => new Set(xs).size === xs.length, { message: 'duplicate item' });
}

/** `Survey.breakdown` for EXPANDED_2024 rows. Null for PILOT_50. */
export const ExpandedBreakdownSchema = z.object({
  cleanliness: z.number().int().min(-3).max(3),
  scent: z.number().int().min(-2).max(2),
  reasons: checklist(EXPANDED_REASONS),
  toiletries: checklist(EXPANDED_TOILETRIES),
  facilities: checklist(EXPANDED_FACILITIES),
});
export type ExpandedBreakdown = z.infer<typeof ExpandedBreakdownSchema>;

/** Native expanded cleanliness (-3..+3) -> the 0-10 value stored in `Survey.cleanliness`. */
export const normaliseExpandedCleanliness = (c: number): number => ((c + 3) / 6) * 10;

export type SurveyItem =
  | { kind: 'scale'; key: string; label: string; value: number; min: number; max: number }
  | { kind: 'checklist'; key: string; label: string; checked: string[]; total: number };

/** The Survey columns the items are built from. */
export interface SurveyRow {
  id: string;
  surveyedAt: Date;
  rubric: SurveyRubric;
  sex: SurveySex | null;
  phase: string | null;
  cleanliness: number;
  scent: number | null;
  aesthetics: number | null;
  music: number | null;
  toiletries: number | null;
  facilities: number | null;
  total: number | null;
  rasStars: number | null;
  remarks: string | null;
  breakdown: unknown;
}

export interface SurveyView {
  id: string;
  surveyedAt: string;
  rubric: SurveyRubric;
  sex: SurveySex | null;
  cleanliness: number;
  total: number | null;
  totalMax: number | null;
  rasStars: number | null;
  phase: string | null;
  remarks: string | null;
  items: SurveyItem[];
}

export const PILOT_TOTAL_MAX = 50;

const PILOT_SCALES = [
  ['cleanliness', 'Cleanliness', 10],
  ['scent', 'Scent', 5],
  ['aesthetics', 'Aesthetics', 5],
  ['music', 'Music', 5],
  ['toiletries', 'Toiletries', 5],
  ['facilities', 'Facilities', 20],
] as const;

function checklistItem(key: string, label: string, list: Checklist, ticked: string[]): SurveyItem {
  const on = new Set(ticked);
  return { kind: 'checklist', key, label, checked: list.filter(([n]) => on.has(n)).map(([, l]) => l), total: list.length };
}

/** Items for one survey, in display order. An EXPANDED_2024 row without a valid breakdown has none. */
export function surveyItems(s: SurveyRow): SurveyItem[] {
  if (s.rubric === 'PILOT_50') {
    return PILOT_SCALES.flatMap(([key, label, max]) => {
      const value = s[key];
      return value === null ? [] : [{ kind: 'scale' as const, key, label, value, min: 0, max }];
    });
  }
  const b = ExpandedBreakdownSchema.safeParse(s.breakdown);
  if (!b.success) return [];
  return [
    { kind: 'scale', key: 'cleanliness', label: 'Cleanliness', value: b.data.cleanliness, min: -3, max: 3 },
    { kind: 'scale', key: 'scent', label: 'Scent', value: b.data.scent, min: -2, max: 2 },
    checklistItem('reasons', 'Why this rating', EXPANDED_REASONS, b.data.reasons),
    checklistItem('toiletries', 'Toiletries', EXPANDED_TOILETRIES, b.data.toiletries),
    checklistItem('facilities', 'Facilities', EXPANDED_FACILITIES, b.data.facilities),
  ];
}

/** The API `Survey` for one row. */
export function toSurveyView(s: SurveyRow): SurveyView {
  return {
    id: s.id,
    surveyedAt: s.surveyedAt.toISOString(),
    rubric: s.rubric,
    sex: s.sex,
    cleanliness: s.cleanliness,
    total: s.total,
    totalMax: s.rubric === 'PILOT_50' && s.total !== null ? PILOT_TOTAL_MAX : null,
    rasStars: s.rasStars,
    phase: s.phase,
    remarks: s.remarks,
    items: surveyItems(s),
  };
}
