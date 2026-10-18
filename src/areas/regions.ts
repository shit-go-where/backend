/** URA Master Plan 2019 planning areas by region, and the URL slug every area page uses. */

export const REGIONS = ['CENTRAL', 'EAST', 'NORTH', 'NORTH_EAST', 'WEST'] as const;
export type Region = (typeof REGIONS)[number];

const AREAS_BY_REGION: Record<Region, string[]> = {
  CENTRAL: [
    'Bishan', 'Bukit Merah', 'Bukit Timah', 'Downtown Core', 'Geylang', 'Kallang', 'Marina East',
    'Marina South', 'Marine Parade', 'Museum', 'Newton', 'Novena', 'Orchard', 'Outram', 'Queenstown',
    'River Valley', 'Rochor', 'Singapore River', 'Southern Islands', 'Straits View', 'Tanglin', 'Toa Payoh',
  ],
  EAST: ['Bedok', 'Changi', 'Changi Bay', 'Pasir Ris', 'Paya Lebar', 'Tampines'],
  NORTH: [
    'Central Water Catchment', 'Lim Chu Kang', 'Mandai', 'Sembawang', 'Simpang', 'Sungei Kadut',
    'Woodlands', 'Yishun',
  ],
  NORTH_EAST: ['Ang Mo Kio', 'Hougang', 'North-Eastern Islands', 'Punggol', 'Seletar', 'Sengkang', 'Serangoon'],
  WEST: [
    'Boon Lay', 'Bukit Batok', 'Bukit Panjang', 'Choa Chu Kang', 'Clementi', 'Jurong East', 'Jurong West',
    'Pioneer', 'Tengah', 'Tuas', 'Western Islands', 'Western Water Catchment',
  ],
};

/** "Downtown Core" -> "downtown-core", "North-Eastern Islands" -> "north-eastern-islands". */
export function areaSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const REGION_BY_SLUG = new Map<string, Region>(
  REGIONS.flatMap((r) => AREAS_BY_REGION[r].map((a) => [areaSlug(a), r] as const)),
);

export function regionOf(area: string): Region | null {
  return REGION_BY_SLUG.get(areaSlug(area)) ?? null;
}
