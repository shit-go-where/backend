import {
  FACILITY_ITEMS,
  REASON_ITEMS,
  TOILETRY_ITEMS,
  areaWords,
  cleanCode,
  coffeeshopName,
  driveFileId,
  lineOfStationCode,
  parseIndexAddress,
  parseLocationText,
  parseScale,
  parseSex,
  parseStationPremise,
  parseTimestamp,
  premiseAliases,
  premiseDisplayName,
  splitChecklist,
  stripPremise,
  tidyAddress,
  toiletLabel,
  venueTypeOfCode,
} from './parse.js';

describe('splitChecklist', () => {
  it('splits against the known items, including items that contain commas', () => {
    const cell =
      'General appearance of toilet looks stain-free. (floor, walls, wall tiles, ceiling, cubicle doors), Floor is free of litter/little presence of litter, Toilets are free of chokage.';
    const r = splitChecklist(cell, REASON_ITEMS);
    expect(r.items).toEqual([
      'General appearance of toilet looks stain-free. (floor, walls, wall tiles, ceiling, cubicle doors)',
      'Floor is free of litter/little presence of litter',
      'Toilets are free of chokage.',
    ]);
    expect(r.rest).toBeNull();
  });

  it('keeps free text ("Others") in order, commas and all', () => {
    const r = splitChecklist('Toilets are free of chokage., Sink leaking, lots of rubbish', REASON_ITEMS);
    expect(r.items).toEqual(['Toilets are free of chokage.']);
    expect(r.rest).toBe('Sink leaking, lots of rubbish');
    expect(splitChecklist('toilet has none of the above ', REASON_ITEMS)).toEqual({ items: [], rest: 'toilet has none of the above', none: false });
  });

  it('drops "None of the Above", matches case-insensitively and stores the canonical spelling', () => {
    expect(splitChecklist('None of the Above', TOILETRY_ITEMS)).toEqual({ items: [], rest: null, none: true });
    const r = splitChecklist('hand soap, TOILET PAPER, Toilet liner/Seat cleaner', TOILETRY_ITEMS);
    expect(r.items).toEqual(['Toilet Paper', 'Hand Soap', 'Toilet liner/Seat cleaner']);
  });

  it('reads the "[Female]" reason and the ambulant item with its brackets', () => {
    const r = splitChecklist(
      'Hand wash area is clean and tidy., [Female] Sanitary bin is clean, intact and lined with plastic bag.',
      REASON_ITEMS,
    );
    expect(r.items).toHaveLength(2);
    expect(r.rest).toBeNull();
    const f = splitChecklist('Mirrors functional, Ambulant facilities available (larger stalls with handrails), Nursing Room Available', FACILITY_ITEMS);
    expect(f.items).toEqual(['Mirrors functional', 'Ambulant facilities available (larger stalls with handrails)', 'Nursing Room Available']);
  });

  it('does not cut an item out of the middle of free text', () => {
    // "Automatic tap" inside a longer phrase is not the item.
    const r = splitChecklist('Automatic tapping noise', FACILITY_ITEMS);
    expect(r.items).toEqual([]);
    expect(r.rest).toBe('Automatic tapping noise');
  });
});

describe('row fields', () => {
  it('reads the sheet timestamp as Singapore time', () => {
    expect(parseTimestamp('24/08/2024 09:15:35')).toBe('2024-08-24T09:15:35+08:00');
    expect(parseTimestamp('1/9/2024 9:05')).toBe('2024-09-01T09:05:00+08:00');
    expect(new Date(parseTimestamp('24/08/2024 09:15:35')!).toISOString()).toBe('2024-08-24T01:15:35.000Z');
    expect(parseTimestamp('2024-08-24')).toBeNull();
  });

  it('reads sexes, scales and Drive ids', () => {
    expect(parseSex('Unisex (incl. Handicapped)')).toBe('UNISEX');
    expect(parseSex(' Female ')).toBe('FEMALE');
    expect(parseSex('Both')).toBeNull();
    expect(parseScale('-3', -3, 3)).toBe(-3);
    expect(parseScale('4', -3, 3)).toBeNull();
    expect(parseScale('', -2, 2)).toBeNull();
    expect(driveFileId('https://drive.google.com/open?id=1AeW822oPhOPkYOBj9arP2-KcPnqx_HQr')).toBe('1AeW822oPhOPkYOBj9arP2-KcPnqx_HQr');
    expect(driveFileId('https://example.com/x.jpg')).toBeNull();
  });
});

describe('Location Codes', () => {
  it('fixes the "M6." typo and maps prefixes to venue types', () => {
    expect(cleanCode('M6.')).toEqual({ code: 'M6', fixed: true });
    expect(cleanCode(' NS22 ')).toEqual({ code: 'NS22', fixed: false });
    expect(venueTypeOfCode('CC4')).toBe('MRT_STATION');
    expect(venueTypeOfCode('CE1')).toBe('MRT_STATION');
    expect(venueTypeOfCode('C73')).toBe('COFFEESHOP');
    expect(venueTypeOfCode('H109')).toBe('HAWKER_CENTRE');
    expect(venueTypeOfCode('B7')).toBe('BUS_INTERCHANGE');
    expect(venueTypeOfCode('M291')).toBe('MALL');
    expect(venueTypeOfCode('X1')).toBeNull();
    expect(lineOfStationCode('EW13')).toBe('EWL');
    expect(lineOfStationCode('CE1')).toBe('CCL');
    expect(lineOfStationCode('TE29')).toBe('TEL');
  });

  it('reads station premises', () => {
    expect(parseStationPremise('Promenade DTL / CCL')).toEqual({ name: 'Promenade', lines: ['DTL', 'CCL'] });
    expect(parseStationPremise('City Hall NSL, EWL')).toEqual({ name: 'City Hall', lines: ['NSL', 'EWL'] });
    expect(parseStationPremise('Tanjong Rhu TEL ')).toEqual({ name: 'Tanjong Rhu', lines: ['TEL'] });
  });

  it('names address-only coffeeshops "Coffeeshop, Blk 103 Gangsa Road"', () => {
    const a = parseIndexAddress('103 GANGSA ROAD #01-35, S(670103)');
    expect(a).toEqual({ block: '103', road: 'Gangsa Road', unit: '#01-35', building: null, postalCode: '670103' });
    expect(coffeeshopName(a)).toBe('Coffeeshop, Blk 103 Gangsa Road');
    expect(tidyAddress(a)).toBe('103 Gangsa Road #01-35, Singapore 670103');
    const b = parseIndexAddress('259 BUKIT PANJANG RING ROAD #01-36, BUKIT PANJANG NEW TOWN S(671259)');
    expect(coffeeshopName(b)).toBe('Coffeeshop, Blk 259 Bukit Panjang Ring Road');
    expect(b.building).toBe('Bukit Panjang New Town');
    // A street address without an HDB unit is not a block.
    expect(coffeeshopName(parseIndexAddress('1018 SEMBAWANG ROAD, S(758495)'))).toBe('Coffeeshop, 1018 Sembawang Road');
    expect(coffeeshopName(parseIndexAddress('116 LORONG 2 TOA PAYOH #01-140, S(310116)'))).toBe('Coffeeshop, Blk 116 Lorong 2 Toa Payoh');
  });

  it('reads hawker centre addresses ("Blk 79, Redhill Lane, S(150079)")', () => {
    expect(parseIndexAddress('Blk 79, Redhill Lane, S(150079)')).toMatchObject({ block: '79', road: 'Redhill Lane', postalCode: '150079' });
    expect(tidyAddress(parseIndexAddress('Blk 676, Woodlands Drive 71, #02-44, S(730676)'))).toBe('676 Woodlands Drive 71 #02-44, Singapore 730676');
  });

  it('tidies premise names and lists their aliases', () => {
    expect(premiseDisplayName('Compass Point (renamed Compass One)')).toBe('Compass One');
    expect(premiseDisplayName('WOODLANDS CIVIC CENTRE')).toBe('Woodlands Civic Centre');
    expect(premiseDisplayName('JEM')).toBe('JEM');
    expect(premiseAliases('Orchard Emerald / Orchard Gateway@Emerald')).toEqual(
      expect.arrayContaining(['Orchard Emerald', 'Orchard Gateway@Emerald']),
    );
    expect(premiseAliases('Marina Bay Sands (Shoppes, Expo & Convention Centre, Hotel)')).toContain('Marina Bay Sands');
  });
});

describe('location within the premise', () => {
  const at = (text: string, ...premise: string[]) => parseLocationText(text, premise);

  it('takes the level out and keeps the rest as a note', () => {
    expect(at('Level 3, near YGF Malatang')).toEqual({ level: 'L3', note: 'Near YGF Malatang', area: null });
    expect(at('Level B1 near Xiaomi').level).toBe('B1');
    expect(at('lvl B2, next to Burger King').level).toBe('B2');
    expect(at('Basement 1, near escalators towards B2 and B3')).toMatchObject({ level: 'B1', note: 'Near escalators towards B2 and B3' });
    expect(at('J8 Basement').level).toBe('B1');
    expect(at('Ground Level, next to Dian Xiao Er').level).toBe('L1');
    expect(at('Level Two').level).toBe('L2');
    expect(at('Tb Plaza l2')).toMatchObject({ level: 'L2', note: 'Tb Plaza' });
    // Not levels: an exit range, a library wing code.
    expect(at('Near Exit 5-7')).toMatchObject({ level: null, note: 'Near Exit 5-7', area: 'Exit 5-7' });
    expect(at('Outside Library L4R').level).toBeNull();
  });

  it('drops a repeated premise name but not a different building', () => {
    expect(at('Bukit Panjang Plaza, Level 2, next to Vivian and Sean', 'Bukit Panjang Plaza')).toMatchObject({ level: 'L2', note: 'Next to Vivian and Sean' });
    expect(at('Hillion, Level 1, Next to Dian Xiao Er', 'Hillion Mall').note).toBe('Next to Dian Xiao Er');
    expect(at('United square mall, level 2 next to toys r us', 'United Square Shopping Mall').note).toBe('Next to toys r us');
    expect(at('Wisma Atria L1 near FUN Toast', 'Wisma Atria').note).toBe('Near FUN Toast');
    expect(at('International Plaza Level 1 near', 'International Plaza').note).toBeNull();
    expect(stripPremise('Orchard Plaza ', ['Orchard Point'])).toBe('Orchard Plaza ');
    expect(stripPremise('Velocity square two', ['Velocity@Novena Square'])).toBe('Velocity square two');
  });

  it('never shows a retraction as a note', () => {
    expect(at('(ignore previous response pls sorry)')).toEqual({ level: null, note: null, area: null });
  });

  it('labels by sex, line side and wing words', () => {
    expect(areaWords('West Wing')).toBe('West Wing');
    expect(areaWords('Lobby A')).toBe('Lobby A');
    expect(areaWords('Exit F')).toBe('Exit F');
    expect(areaWords('next to the lifts')).toBeNull();
    expect(toiletLabel('MALE')).toBe("Men's");
    expect(toiletLabel('FEMALE', { lineSide: 'NEL' })).toBe("Women's, NEL side");
    expect(toiletLabel('UNISEX', { area: 'West Wing' })).toBe('Accessible / unisex, West Wing');
  });
});
