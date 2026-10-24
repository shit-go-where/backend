import {
  EXPANDED_FACILITIES,
  EXPANDED_REASONS,
  EXPANDED_TOILETRIES,
  ExpandedBreakdownSchema,
  normaliseExpandedCleanliness,
  surveyItems,
  toSurveyView,
  type SurveyRow,
} from './survey-items.js';

const at = new Date('2024-03-15T00:00:00+08:00');

const pilot: SurveyRow = {
  id: 's1',
  surveyedAt: at,
  rubric: 'PILOT_50',
  sex: 'MALE',
  phase: null,
  cleanliness: 8,
  scent: 4,
  aesthetics: 3,
  music: 0,
  toiletries: 3,
  facilities: 15,
  total: 33,
  rasStars: 4,
  remarks: 'Hand dryer broken',
  breakdown: null,
};

/** Hand-written breakdown in the shape the survey2 importer writes. */
const breakdown = {
  cleanliness: -2,
  scent: 0,
  reasons: ['Toilets are free of chokage.', 'Hand wash area is clean and tidy.'],
  toiletries: ['Hand Soap', 'Toilet Paper', 'Hand Dryer'],
  facilities: ['Mirrors functional', 'Taps functional', 'Toilets functional', 'Door locks functional', 'Bidet available'],
};

const expanded: SurveyRow = {
  id: 's2',
  surveyedAt: new Date('2024-08-24T09:15:34+08:00'),
  rubric: 'EXPANDED_2024',
  sex: 'FEMALE',
  phase: null,
  cleanliness: normaliseExpandedCleanliness(-2),
  scent: null,
  aesthetics: null,
  music: null,
  toiletries: null,
  facilities: null,
  total: null,
  rasStars: null,
  remarks: 'Floor is wet',
  breakdown,
};

describe('checklists', () => {
  it('have the sizes the totals promise', () => {
    expect(EXPANDED_TOILETRIES).toHaveLength(5);
    expect(EXPANDED_FACILITIES).toHaveLength(15);
    expect(EXPANDED_REASONS).toHaveLength(6);
  });
});

describe('surveyItems: PILOT_50', () => {
  it('lists the six rubric scales in order', () => {
    expect(surveyItems(pilot)).toEqual([
      { kind: 'scale', key: 'cleanliness', label: 'Cleanliness', value: 8, min: 0, max: 10 },
      { kind: 'scale', key: 'scent', label: 'Scent', value: 4, min: 0, max: 5 },
      { kind: 'scale', key: 'aesthetics', label: 'Aesthetics', value: 3, min: 0, max: 5 },
      { kind: 'scale', key: 'music', label: 'Music', value: 0, min: 0, max: 5 },
      { kind: 'scale', key: 'toiletries', label: 'Toiletries', value: 3, min: 0, max: 5 },
      { kind: 'scale', key: 'facilities', label: 'Facilities', value: 15, min: 0, max: 20 },
    ]);
  });
  it('skips a missing column instead of inventing a 0', () => {
    expect(surveyItems({ ...pilot, music: null }).map((i) => i.key)).not.toContain('music');
  });
  it('reports the /50 total', () => {
    expect(toSurveyView(pilot)).toMatchObject({ rubric: 'PILOT_50', sex: 'MALE', cleanliness: 8, total: 33, totalMax: 50, rasStars: 4 });
  });
});

describe('surveyItems: EXPANDED_2024', () => {
  it('builds the native scales and the three checklists with display labels in checklist order', () => {
    expect(surveyItems(expanded)).toEqual([
      { kind: 'scale', key: 'cleanliness', label: 'Cleanliness', value: -2, min: -3, max: 3 },
      { kind: 'scale', key: 'scent', label: 'Scent', value: 0, min: -2, max: 2 },
      { kind: 'checklist', key: 'reasons', label: 'Why this rating', checked: ['Clean, tidy sinks', 'No choked toilets'], total: 6 },
      { kind: 'checklist', key: 'toiletries', label: 'Toiletries', checked: ['Toilet paper', 'Hand dryer', 'Hand soap'], total: 5 },
      {
        kind: 'checklist',
        key: 'facilities',
        label: 'Facilities',
        checked: ['Mirrors work', 'Taps work', 'Toilets work', 'Door locks work', 'Bidet'],
        total: 15,
      },
    ]);
  });
  it('has no total, and cleanliness is the 0-10 normalised value', () => {
    const v = toSurveyView(expanded);
    expect(v).toMatchObject({ rubric: 'EXPANDED_2024', sex: 'FEMALE', total: null, totalMax: null, rasStars: null });
    expect(v.cleanliness).toBeCloseTo(10 / 6);
    expect(v.surveyedAt).toBe('2024-08-24T01:15:34.000Z');
  });
  it('normalises -3..+3 onto 0-10', () => {
    expect([-3, 0, 3].map(normaliseExpandedCleanliness)).toEqual([0, 5, 10]);
  });
  it('has no items when the breakdown is missing or malformed', () => {
    expect(surveyItems({ ...expanded, breakdown: null })).toEqual([]);
    expect(surveyItems({ ...expanded, breakdown: { ...breakdown, cleanliness: 5 } })).toEqual([]);
  });
});

describe('ExpandedBreakdownSchema', () => {
  it('accepts the documented shape', () => {
    expect(ExpandedBreakdownSchema.parse(breakdown)).toEqual(breakdown);
  });
  it('rejects unknown items, duplicates and "None of the Above"', () => {
    expect(ExpandedBreakdownSchema.safeParse({ ...breakdown, toiletries: ['Hand soap'] }).success).toBe(false);
    expect(ExpandedBreakdownSchema.safeParse({ ...breakdown, toiletries: ['Hand Soap', 'Hand Soap'] }).success).toBe(false);
    expect(ExpandedBreakdownSchema.safeParse({ ...breakdown, facilities: ['None of the Above'] }).success).toBe(false);
  });
});
