# API contract (v1)

Single source of truth for request/response shapes between `backend/` and `frontend/`.
The OpenAPI spec generated from the code (`pnpm openapi` → `openapi.json`) must match this.
If you change a shape, change it here too.

Conventions
- JSON everywhere. Dates are ISO strings. Coordinates are `lat`/`lng` numbers (WGS84).
- The browser calls `/api/<path>`; Next rewrites to the API at `/<path>` (no `/api` prefix in Nest).
- Auth: httpOnly cookie `sgw_session`. 401 `{statusCode, message}` when sign-in required.
- Lists are `{ items: T[] }`, paginated lists add `nextCursor: string | null` (`?cursor=`).
- Errors: Nest default `{ statusCode, message, error? }`; zod failures are 400 with `errors`.
- Validation: every body/query is a zod schema wrapped with `createZodDto`; responses use
  `@ZodResponse` / `ZodSerializerDto` where practical so the spec carries response types.

## Shared types

```ts
type Feature =
  | 'TOILET_PAPER' | 'HAND_TOWEL' | 'HAND_DRYER' | 'HAND_SOAP' | 'SEAT_LINER'
  | 'BIDET' | 'AUTO_FLUSH' | 'AUTO_TAP' | 'AUTO_SOAP' | 'COAT_HOOK' | 'FEEDBACK_DEVICE'
  | 'SIGNAGE' | 'POSTERS' | 'AMBULANT' | 'ACCESSIBLE' | 'CHILD' | 'BABY_CHANGE'
  | 'NURSING_ROOM' | 'SHOWER' | 'SITTING' | 'SQUAT' | 'MALE' | 'FEMALE' | 'UNISEX' | 'FREE'
  | 'SANITARY_BIN' | 'PERIOD_PRODUCTS' | 'MIRROR' | 'WATER_REFILL' | 'ABLUTION';
type Purpose = 'PEE' | 'POO' | 'BABY' | 'SHOWER' | 'FRESHEN_UP' | 'PERIOD';
type VenueType = 'MRT_STATION' | 'BUS_INTERCHANGE' | 'MALL' | 'HAWKER_CENTRE' | 'COFFEESHOP'
  | 'COMMUNITY_CLUB' | 'PARK' | 'LIBRARY' | 'HOSPITAL' | 'SPORTS_CENTRE' | 'OTHER';
type VenueToiletStatus = 'HAS_TOILETS' | 'NONE' | 'UNKNOWN' | 'USES_NEARBY';
type ToiletTier = 'VERIFIED' | 'COMMUNITY' | 'IMPORTED';
type ToiletStatus = 'ACTIVE' | 'CLOSED' | 'RENOVATION' | 'PENDING' | 'REJECTED';
type AreaType = 'PAID_AREA' | 'UNPAID_AREA' | 'NOT_APPLICABLE' | 'UNKNOWN';
type StatusKind = 'ALL_GOOD' | 'NO_PAPER' | 'NO_SOAP' | 'LONG_QUEUE' | 'BEING_CLEANED' | 'BROKEN' | 'CLOSED_NOW';
type Role = 'USER' | 'TRUSTED' | 'MODERATOR' | 'ADMIN';
type Sex = 'MALE' | 'FEMALE' | 'UNISEX';
type SexPreference = 'MALE' | 'FEMALE';   // `sex` on list endpoints: "usable by" (see Toilets)
type SurveyRubric = 'PILOT_50' | 'EXPANDED_2024';

// Stored in Venue.openingHours / Toilet.openingHours (Json). Toilet null => use venue's.
type OpeningHours =
  | { type: 'always' }
  | { type: 'weekly'; periods: { days: number[]; open: 'HH:MM'; close: 'HH:MM' }[]; inferred?: boolean }
  //  days: 0=Sun..6=Sat, Singapore time. close < open means past midnight.
  | { type: 'osm'; value: string };   // raw OSM opening_hours; best-effort parse, unknown => openNow null

interface PhotoRef { id: string; url: string; thumbUrl: string | null }

interface VenueLite {
  id: string; name: string; type: VenueType; lines: string[];
  lat: number; lng: number; toiletStatus: VenueToiletStatus; note: string | null;
}

interface ActiveStatus { kind: StatusKind; count: number; latestAt: string }

interface ToiletSummary {
  id: string;
  label: string | null;
  venue: VenueLite;
  lat: number; lng: number;
  level: string | null;             // normalised (see "Levels"): "B1", "L3", "M", "B1; L3"; free text if unreadable
  areaType: AreaType;
  tier: ToiletTier;
  status: ToiletStatus;
  features: Feature[];              // features with present=true
  sex: Sex | null;                  // from features: UNISEX present → UNISEX; MALE and not FEMALE → MALE; FEMALE and not MALE → FEMALE; else null
  scoreCleanliness: number | null;  // 0-10 blended
  surveyTotal: number | null;       // latest survey total, 0-50 (PILOT_50 only; null for other rubrics)
  rasStars: number | null;
  reviewCount: number;
  seenBy: number;                   // distinct signed-in people who have been there: the submitter + first check-ins within 150 m (min 1)
  activeStatus: ActiveStatus[];     // unexpired status reports grouped by kind; unconfirmed anonymous closures left out
  lastVerifiedAt: string | null;
  needsResurvey: boolean;
  openNow: boolean | null;          // null = unknown
  photoThumb: string | null;
  distanceM?: number;               // present when a location was given
  walkSecondsEstimate?: number;     // straight-line * 1.3 / 1.25 m/s
}

interface ToiletPin {                // minimal, for map rendering
  id: string; lat: number; lng: number; tier: ToiletTier; status: ToiletStatus;
  scoreCleanliness: number | null; hasIssue: boolean; venueType: VenueType;
  venueId: string;                   // groups a building's toilets (map stacks, same-building clusters, floor picker)
  level: string | null;              // as ToiletSummary.level
  levelOrder: number | null;         // sort key (see "Levels"); null when the level is unknown or unreadable
  sex: Sex | null;                   // as ToiletSummary.sex
}

// Levels (src/common/level.ts; frontend/lib/level.ts mirrors it). Every write of a toilet's level is
// normalised: trimmed, case-insensitive; "basement 1", "b1", "B01", "-1" → "B1"; "level 3", "l3", "lvl 3", "3",
// "03", "#03" → "L3"; "ground", "g", "gf", "ground floor" (and "0") → "L1" (ground is L1 in Singapore);
// "mezzanine", "m" → "M"; lists split on ; , / & " and " are normalised part by part and joined with "; ".
// Anything unreadable is kept as typed (trimmed). levelOrder: B<n> → -n, L<n> → n, M → 1.5, a list → its lowest.

// Display-ready and rubric-agnostic (src/toilets/survey-items.ts): render `items` in order.
interface Survey {
  id: string; surveyedAt: string;
  rubric: SurveyRubric;
  sex: Sex | null;                   // the toilet the surveyor looked at
  cleanliness: number;               // 0-10 for every rubric (feeds scoreCleanliness)
  total: number | null;              // PILOT_50: /50; null when the rubric has no total
  totalMax: number | null;           // 50 for PILOT_50, else null
  rasStars: number | null; phase: string | null; remarks: string | null;
  items: SurveyItem[];
}
type SurveyItem =
  | { kind: 'scale'; key: string; label: string; value: number; min: number; max: number }    // "Cleanliness -2 of -3..+3"
  | { kind: 'checklist'; key: string; label: string; checked: string[]; total: number };      // "Toiletries: 3 of 5"; checked = display labels
// PILOT_50 items (all scale, min 0): cleanliness /10, scent /5, aesthetics /5, music /5, toiletries /5, facilities /20.
// EXPANDED_2024 items: cleanliness -3..3 and scent -2..2 (scale); "Why this rating" (key reasons, 6), Toiletries (5),
// Facilities (15) (checklist). An EXPANDED_2024 row without a valid breakdown has no items.

interface Review {
  id: string; cleanliness: number /*1-5*/; comment: string | null; createdAt: string;
  user: { handle: string | null; avatarUrl: string | null };   // avatarUrl is always null (profile pictures are not public)
  photos: PhotoRef[];
}

interface ToiletDetail extends Omit<ToiletSummary, 'venue'> {
  venue: VenueLite & { address: string | null; planningArea: string | null };
  accessNote: string | null;
  nearestExit: string | null;
  near: string | null;                 // "120 m from Tampines MRT": closest non-OTHER place within 1.5 km, only when the venue has no address
  openSubmissionId: string | null;     // PENDING toilets: the open NEW_TOILET submission (PENDING/NEEDS_INFO/ESCALATED), for /review?id=; else null
  openingHours: OpeningHours | null;   // effective (toilet's or venue's)
  verifiedBy: { handle: string } | null; // last "still accurate" verifier (GROWTH.md 1.7); null if unknown, no handle, deleted, or Me.verifierCredit=false
  featureDetails: { feature: Feature; present: boolean; source: string; observedAt: string }[];
  latestSurvey: Survey | null;
  surveyCount: number;
  surveys: { surveyedAt: string; rubric: SurveyRubric }[]; // every survey, newest first (the first is latestSurvey)
  reviews: Review[];                   // latest 10
  photos: PhotoRef[];                  // approved only
  myReview: Review | null;             // when signed in
  source: string;                      // DataSource
  attribution: string | null;          // e.g. "© OpenStreetMap contributors" for OSM
  siblings: { id: string; label: string | null; level: string | null; levelOrder: number | null; status: ToiletStatus;
              sex: Sex | null }[];   // sex as on ToiletSummary
                                       // the other ACTIVE toilets at the same venue, lowest levelOrder first, unknown levels last (max 50)
}

interface StatusReport {
  id: string; kind: StatusKind; confirmations: number; createdAt: string; expiresAt: string; confirmedByMe: boolean;
  // A signed-out CLOSED_NOW / BROKEN report nobody has backed up: shown, but ignored by activeStatus, pins (hasIssue)
  // and routing until a signed-in person confirms it or reports the same kind, or a second device reports it.
  unconfirmed: boolean;
}

interface Badge { id: string; name: string; description: string; icon: string; awardedAt?: string }

interface Me {
  id: string; email: string; handle: string | null; displayName: string; avatarUrl: string | null;
  role: Role; trustScore: number; leaderboardOptIn: boolean; points: number;   // leaderboardOptIn: true unless turned off
  badges: Badge[]; needsHandle: boolean;   // false for every live account (each gets a random handle at sign-up)
  handleAuto: boolean;                 // the handle is the random one from sign-up (adjective_noun_NN); changing it is free
  handleChangeableAt: string | null;   // when the handle can next be changed (once per 30 days); null = now
  trust: { score: number; threshold: 50; isTrusted: boolean };   // isTrusted = role TRUSTED or above
  openSubmissions: { count: number; limit: 10 };                 // open submissions from the last 14 days vs the cap
  unseen: { resolvedSubmissions: number; badges: number; points: number };  // since lastSeenActivityAt (else sign-up)
  lastSeenActivityAt: string | null;
  telegramLinked: boolean;             // a Telegram chat is linked to this account (BOT.md T15)
}

// EXPIRED is legacy (old rows only): expiry now escalates to ESCALATED.
type SubmissionState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_INFO' | 'EXPIRED' | 'ESCALATED';
type ResolutionCode =
  | 'auto_on_site_photo'    // "Live straight away: added on site with a photo."
  | 'confirmed_on_site'     // "Confirmed by someone who checked in there."
  | 'community_approved'    // "Approved by people nearby."
  | 'trusted_approved'      // "Approved by a trusted reviewer."
  | 'moderator_approved'    // "Approved by a moderator."
  | 'moderator_rejected'    // "Rejected by a moderator."
  | 'moderator_needs_info'  // "A moderator asked for more information."
  | 'peer_needs_info'       // "Two reviewers think something is off. Add more detail and resubmit."
  | 'escalated_expired'     // "Nobody nearby confirmed it in time, so a moderator will review it."
  | 'escalated_flagged'     // "Two people flagged this toilet, so a moderator will review it."
  | 'expired';              // "Expired before anyone confirmed it." (legacy)

interface SubmissionView {
  id: string;
  kind: 'NEW_TOILET' | 'EDIT_TOILET' | 'CLOSE_TOILET';
  state: SubmissionState;              // an open one past expiresAt reads ESCALATED even before the expire job runs
  payload: NewToiletPayload | EditToiletPayload | CloseToiletPayload;
  toilet: { id: string; label: string | null; venueName: string; lat: number; lng: number } | null;
  venue: VenueLite | null;
  submittedBy: { handle: string | null };
  onSite: boolean;                     // submitter stood within 150 m of the toilet
  hasPhoto: boolean;
  path: 'auto' | 'on_site_check_in' | 'nearby_quorum';  // which rule decides it (see "Trust model v2")
  nearbyApprovals: number;             // APPROVE votes cast within 150 m (check-ins count)
  needed: number;                      // nearby confirmations still needed to go live; 0 once decided or when only a moderator can decide
  escalated: boolean;                  // state === 'ESCALATED'
  submitterDistanceM: number | null;   // how far from the toilet the submitter stood (no coordinates exposed)
  reviewerNotes: { value: 'APPROVE' | 'REJECT'; note: string | null; createdAt: string; nearby: boolean; viaCheckIn: boolean }[];
                                       // every vote, newest first, anonymised (no user id / handle)
  current: { label?: string | null; level?: string | null; areaType?: AreaType; nearestExit?: string | null;
             accessNote?: string | null; openingHours?: OpeningHours | null;  // effective hours: the toilet's, else its venue's
             features?: Partial<Record<Feature, boolean | null>> } | null;
                                       // EDIT_TOILET while open: the toilet's values now for the changed fields (null feature = no record)
  approvals: number; rejections: number;
  createdAt: string; expiresAt: string; resolvedAt: string | null;
  resolution: ResolutionCode | null;
  resolutionText: string | null;       // plain English for `resolution` (the comments above)
  resolutionNote: string | null;       // a moderator's own note on their decision
  distanceM?: number;
  myVote: 'APPROVE' | 'REJECT' | null;
  photos: PhotoRef[];
  canVote: boolean;                    // false for own / decided / flagged-escalated submissions or once voted
}

interface NewToiletPayload {
  venueId?: string;                       // existing venue, or
  newVenue?: { name: string; type: VenueType };
  label?: string; lat: number; lng: number; level?: string;
  areaType?: AreaType; accessNote?: string;
  features: Partial<Record<Feature, boolean>>;
  photoIds: string[];                     // 0-10 (optional on create, default [])
  note?: string;                          // added via PATCH /submissions/:id (NEEDS_INFO)
}
interface EditToiletPayload {
  changes: { label?: string; level?: string; areaType?: AreaType; nearestExit?: string; accessNote?: string;
             openingHours?: HoursInput; features?: Partial<Record<Feature, boolean>> };
  photoIds?: string[];
  note?: string;
}
// What a visitor can send: OpeningHours without 'osm' or `inferred`. Times HH:MM; close may be '24:00',
// and a close at or before the open runs past midnight. 1-14 periods, each with 1-7 days (0 = Sun).
type HoursInput = { type: 'always' } | { type: 'weekly'; periods: { days: number[]; open: string; close: string }[] };
interface CloseToiletPayload { status: 'CLOSED' | 'RENOVATION'; reason: string; note?: string }
```

## Endpoints

### Health
- `GET /health` → `{ ok: true, db: 'up', time }` (readiness: runs `SELECT 1`; 503 `{ ok: false, db: 'down' }`)
- `GET /health/live` → `{ ok: true, commit: string | null, time }` (liveness: never touches the database;
  `commit` is `VERCEL_GIT_COMMIT_SHA`, null off Vercel; `Cache-Control: no-store`; not rate-limited)

### Toilets (owner: finder agent)
- `GET /toilets/nearby?lat&lng&radius=1000&features=BIDET,ACCESSIBLE&openNow=true&areaType=UNPAID_AREA&tier=VERIFIED,COMMUNITY&limit=50`
  → `{ items: ToiletSummary[] }` sorted by distance. radius max 5000, limit max 200. Only ACTIVE (and PENDING when `includePending=true`).
  Toilets at venues with `toiletStatus=NONE` are never returned (here, in-bounds, recommend). `features` = all must be present.
  `openNow=true` drops only toilets that are definitely closed; unknown hours (`openNow: null`) stay.
  `sex=MALE|FEMALE` keeps toilets usable by that sex: MALE → `sex` in (MALE, UNISEX, null); FEMALE → (FEMALE, UNISEX, null). Omitted = all.
  The same `sex` filter is accepted by in-bounds, `GET /stations/:slug`, `GET /areas/:slug` and `POST /routing/recommend` (body field).
- `GET /toilets/in-bounds?minLat&maxLat&minLng&maxLng&features=...&sex=MALE&includePending=true` → `{ items: ToiletPin[] }` (cap 3000).
- `GET /toilets/sitemap` → `{ items: { id: string; updatedAt: string }[] }`: every ACTIVE / CLOSED / RENOVATION toilet not at a NONE venue, for the frontend's sitemap.xml.
- `GET /toilets/:id` → `ToiletDetail` (optional auth for `myReview`).
- `GET /toilets/:id/reviews?cursor&limit=20` (limit max 50) → `{ items: Review[], nextCursor }` newest first; `nextCursor` is the last item's id. Public review photos are approved ones only.
- `POST /toilets/:id/reviews` (auth) `{ cleanliness: 1-5, comment?: string<=1000, photoIds?: string[] (max 10) }` → `Review` (201, upsert, one per user per toilet). Awards REVIEW_POSTED, plus REVIEW_WITH_PHOTO if photos.
  `photoIds` must be the caller's own `confirmed` photos not attached to another review/toilet, else 400. When given it is the full set (others are detached); omitted keeps existing photos.
  The response (and `ToiletDetail.myReview`) include the author's not-yet-approved photos.
- `GET /toilets/:id/status` → `{ items: StatusReport[] }` active only.
- `POST /toilets/:id/status` (optional auth) `{ kind: StatusKind, afterRoute?: boolean }` → `StatusReport`. `afterRoute` is analytics only (post-route card). TTL 2h, CLOSED_NOW 24h. Same user+toilet+kind within 30 min → returns existing.
  Signed out: allowed. The device gets the `sgw_anon` cookie (see "Anonymous device"); TTL is 1 h for every kind; dedupe is per device;
  a lone anonymous CLOSED_NOW / BROKEN is `unconfirmed: true` and does not affect activeStatus, pins or routing (see StatusReport).
  Max 30 signed-out reports per IP per Singapore day (429 "Too many reports from this network today. Sign in to keep reporting.").
- `POST /status/:id/confirm` (auth, signed-in only, also for anonymous reports) → `StatusReport` (200). A confirmation makes an unconfirmed anonymous closure count. Extends expiresAt by 1h (max 6h past createdAt, never shortens a 24h CLOSED_NOW). Awards STATUS_CONFIRMED to the original reporter (refId = `${statusReportId}:${confirmerId}`), at most once per confirmer per reporter per Singapore day (later confirmations still count for the report, they just pay nothing). Own report → 400; unknown/expired → 404; confirming twice is a no-op returning the report.
  Anonymous reporters earn no STATUS_CONFIRMED (their reports move to their account on sign-in; earlier confirmations are not paid).
  Rate limits: POST status 10/min, confirm 30/min, flags 5/min (per signed-in user, else client IP; src/common/throttle.ts).
  Other route limits (same keying, default 120/min elsewhere): check-ins 10/min, verify 5/min, reviews 10/min,
  POST/PATCH submissions 10/min, votes 20/min, media presign and confirm 30/min, recommend 30/min, walk 30/min, geo/search 60/min.
  All counters are in memory per function instance (advisory, reset on cold start).
- `POST /toilets/:id/flags` (auth) `{ reason: string 3-500 }` → `{ id }`. When 2 distinct people (not the submitter) have open flags on a
  toilet that was auto-published (trust model v2), it goes back to PENDING and its submission to ESCALATED (`escalated_flagged`).
  `POST /toilets/:id/verify` with `accurate: false` creates a Flag too and counts the same way.

### Venues (owner: finder agent)
- `GET /venues/nearby?lat&lng&radius=1000` → `{ items: (VenueLite & { distanceM: number; toiletCount: number })[] }` includes NONE / USES_NEARBY venues. `toiletCount` = ACTIVE toilets (always 0 for NONE venues).
- `GET /venues/search?q&lat?&lng?` → `{ items: VenueLite[] }` (name ILIKE, max 20, nearest first when lat/lng given).
- `GET /venues/:id` → `VenueLite & { address, planningArea, toilets: ToiletSummary[] }`

### Areas (browse by URA planning area)
- `AreaSummary` = `{ slug, name, region: 'CENTRAL'|'EAST'|'NORTH'|'NORTH_EAST'|'WEST'|null, toiletCount, verifiedCount, venueCount, indexable }`.
  `slug` is the kebab-cased `Venue.planningArea` ("Downtown Core" → `downtown-core`). Counts are ACTIVE toilets not at NONE venues.
  `indexable` = `toiletCount >= 3`; thinner area pages render but are `noindex` and left out of the sitemap.
- `GET /areas` → `{ items: AreaSummary[] }` A to Z, areas with at least one ACTIVE toilet.
- `GET /areas/:slug?sex=MALE|FEMALE` → `AreaSummary & { pendingCount, center: { lat, lng } | null, venues: AreaVenue[], noToiletVenues: VenueLite[] }`, 404 for an unknown slug.
  `sex` (optional, "usable by" as on /toilets/nearby) filters the toilets before anything is counted, so counts and places follow it.
  `AreaVenue` = `VenueLite & { address, near: { name, type, distanceM } | null, toilets: ToiletSummary[] }`: places with ACTIVE / CLOSED / RENOVATION
  toilets (never PENDING), best toilet first (open, then tier, then cleanliness), places ranked by their best toilet. `near` is the closest
  non-OTHER place within 1.5 km (in any area), set only when the place has no address. `center` is the area's namesake MRT station, else the
  listed place nearest the middle. `noToiletVenues` are NONE / USES_NEARBY places in the area.

### Stations and the line board (GROWTH.md 1.2, 1.11)
- `StationSummary` = `{ slug, name, lines: { code, name }[], lat, lng, toiletStatus: VenueToiletStatus, toiletCount, verifiedCount, bestScore: number | null, lastVerifiedAt: string | null, indexable }`
  for every `MRT_STATION` venue (MRT and LRT). Counts are ACTIVE toilets; toilets at NONE stations are never counted. `slug` = kebab-cased name.
  `indexable` = has toilets, a definite NONE / USES_NEARBY answer, or an ACTIVE toilet elsewhere within 400 m.
- `GET /stations` → `{ items: StationSummary[] }` A to Z.
- `GET /stations/:slug?sex=MALE|FEMALE` → `StationSummary & { note: string | null, area: { slug, name } | null, toilets: ToiletSummary[], nearby: { toilet: ToiletSummary, distanceM }[] }`;
  `sex` (optional, "usable by") filters `toilets`, `nearby` and the counts alike;
  404 unknown. `toilets`: in the station, ACTIVE / CLOSED / RENOVATION (never PENDING), best first. `nearby`: ACTIVE toilets at other places
  within 400 m, nearest first, max 5. `indexable` follows the same rule as the list.
- `GET /leaderboard/lines` → `{ items: { rank, code, name, stations, stationsWithToilets, scoredStations, avgScore: number | null, freshPct: number | null, checkInsWeek }[] }`.
  An interchange counts for every line it serves. `avgScore` = mean of each station's best toilet score; `freshPct` = % of the line's
  Verified + Community toilets verified within 90 days. Ranked by `avgScore` (ties share a rank, unscored last). Cached 5 min.

### Routing (owner: finder agent)
- `POST /routing/started` `{ toiletId }` → 200 `{ ok: true }`. Someone started walking there: adds 1 to that toilet's count for the
  Singapore day (`ToiletRouteDaily`, counts only, no person). 404 unless ACTIVE. 100 per IP per day (429), throttled 20/min.
- `POST /routing/recommend` `{ lat, lng, urgent?: boolean, purpose?: Purpose, require?: Feature[], areaType?: AreaType, sex?: SexPreference, openNow?: boolean, radiusM?: number (default 1500, urgent 800 then widen), weights?: { distance?: number; cleanliness?: number; freshness?: number }, level?: string (1-20) }`
  → `{ items: { toilet: ToiletSummary; score: number; walkSeconds: number; walkDistanceM: number; reasons: string[]; route: { polyline: [number, number][]; source: 'onemap' | 'estimate' } | null }[]; searchedRadiusM: number; skippedVenues: { name: string; toiletStatus: VenueToiletStatus; note: string | null; distanceM: number }[] }`
  `purpose` adds soft preferences (src/routing/purposes.ts): missing features add cost, nothing is filtered out.
  `level` is the floor the person is on ("B1", "L3", "level 3": normalised like toilet levels; a body field, since this is a POST).
  Floors (src/routing/levels.ts), only for toilets whose `levelOrder` is known: with `level`, each floor between them and the
  toilet adds 40 s (B1 → L1 is one floor; M is half a floor above L1), counted like walking time in the ranking, added to
  `walkSeconds`, and stated as the second reason (`"On your level"`, `"1 floor up"`, `"2 floors down"`). Without `level` (or one
  that is not a floor), toilets 20 s per floor away from the ground (L1) rank lower; `walkSeconds` and reasons are unchanged.
  Each item also has `unconfirmed: boolean`: a PENDING community toilet nobody has confirmed yet. Calm (non-urgent) results may include
  them, ranked below active toilets of similar distance (+0.1 cost, about 330 m) and with the reason
  `"Unconfirmed: added by the community, not yet confirmed"` in place of `"Community verified"`. Urgent mode never includes them.
  Top 3. Toilets that are definitely closed now (openNow === false) are never recommended; unknown hours stay eligible. Route only computed for the top 3 via OneMap when configured; else `route: null` and `walkSeconds` / `walkDistanceM` are estimates (straight line × 1.3).
  `score` is 0-100, higher = better. Hard filters (also in urgent mode): `require`, `areaType`, `sex` ("usable by"), `openNow` (definitely-closed only), ACTIVE only
  (plus PENDING in calm mode, flagged `unconfirmed`), no unexpired CLOSED_NOW/BROKEN report that is confirmed or reported twice
  (unconfirmed anonymous reports are ignored). Urgent: radius 800 → 1500 → 3000 until ≥1 result, `radiusM`/`weights` ignored.
  Reasons look like `"4 min walk"`, `"Bidet"`, `"Clean 8.2/10"`, `"Reported: no paper 40 min ago"`, `"Verified 2024 survey"` (either 2024 fieldwork source). `skippedVenues` max 10, nearest first.
- `GET /routing/walk?fromLat&fromLng&toLat&toLng` → `{ distanceM, durationS, polyline: [lat,lng][], source }`. Without OneMap (or on failure/timeout 4 s) `source: 'estimate'` with a 2-point straight polyline. Never 5xx.
- `GET /geo/search?q` → `{ items: { name: string; address: string; lat: number; lng: number }[] }` (OneMap search proxy, no token needed). Max 10; `[]` when OneMap fails.

### Auth & me (owner: accounts agent)
- `GET /auth/google?redirect=/path` → 302 to Google. State cookie (`sgw_oauth`, httpOnly, signed, 10 min) for CSRF.
  `redirect` must be a relative path starting with `/` (not `//`), else 400. 503 when Google env vars are missing.
- `GET /auth/callback?code&state` → sets `sgw_session`, 302 to `PUBLIC_APP_URL + redirect`. Emails in ADMIN_EMAILS become ADMIN.
  Every failure → 302 to `PUBLIC_APP_URL/login?redirect=<saved redirect, else />&error=<code>` with no session:
  `expired` (state cookie missing, expired or mismatched), `access_denied` (Google sent `error`, e.g. the user cancelled),
  `no_code`, `email_unverified`, `google_failed`. (503 only when Google env vars are missing.)
  On success (and on `dev-login`), this browser's anonymous check-ins and status reports (`sgw_anon`) move to the account, their
  banked check-in points are paid (CHECK_IN max 5 per original Singapore day, FIRST_CHECK_IN_AT_TOILET once per toilet, ledger rows
  back-dated to the check-in), badges are evaluated, and `sgw_anon` is cleared. Idempotent; a failed merge never blocks sign-in.
  Seen by is not incremented by merged check-ins.
- `POST /auth/logout` → 204, clears cookie.
- `POST /auth/dev-login` `{ email, displayName? }` → `Me`. Only when `DEV_LOGIN_ENABLED=true` (404 otherwise).
- `GET /me` → `Me` (401 if signed out).
- `PATCH /me` `{ handle?: /^[a-z0-9_]{3,20}$/, displayName?: string 1-50, leaderboardOptIn?: boolean, verifierCredit?: boolean }` → `Me` (409 on handle taken or reserved, e.g. `admin`, `sgw`). Handle is trimmed and lowercased before validation.
  This is also how a handle is changed: choosing the first handle, or replacing the random sign-up one (`handleAuto`), is free;
  changing one you picked is allowed once every 30 days
  (429 "You can change your handle once every 30 days. You can change it again from 18 Nov 2026."). `Me.handleChangeableAt` says when.
- `POST /me/activity/seen` → 200 `{ ok: true, seenAt: string }`. Sets `lastSeenActivityAt = now`, so `Me.unseen` drops to zeros.
  `Me.unseen` counts since then: `resolvedSubmissions` = own submissions APPROVED/REJECTED since (not auto-published ones),
  `badges` = badges awarded since, `points` = sum of ledger deltas since, `routed` = route starts (`POST /routing/started`) to toilets
  you helped on Singapore days after the last visit.
- `Me.impact` = `{ toilets, routedWeek }` (GROWTH.md 1.3): `toilets` you added (createdBy), last verified, or checked in at within 90 days;
  `routedWeek` = route starts to them over the last 7 Singapore days. `Me.verifierCredit` (default true) shows your handle as `verifiedBy`.
- `DELETE /me` → 204, clears cookie. Anonymises the user row (email `deleted-<id>@deleted.invalid`, no handle/avatar/googleSub, "Deleted user", role USER, trust 0) and deletes their check-ins, points ledger and badges. Reviews, submissions, votes, photos, status reports and flags stay, attributed to the anonymous user, minus: `submittedLat/Lng` on their submissions (so `submitterDistanceM` reads null), their vote comments, and the reason text of their resolved flags (open flags keep it for the moderator).
- `GET /me/activity?cursor&limit=30` (limit max 100) → `{ items: { id, delta, reason, refId, createdAt }[], nextCursor }` newest first.
- `POST /me/telegram/link-token` → 200 `{ url: string; expiresAt: string }` (BOT.md T15). `url` is
  `https://t.me/<TELEGRAM_BOT_USERNAME>?start=link_<token>`: a one-time 32-byte token, stored only as its SHA-256 hash, valid 10 minutes,
  cleared when the bot uses it (a new request replaces the old token). Opening it in Telegram links that chat to the account and moves
  the chat's anonymous check-ins and reports over (same merge as sign-in). 503 when the bot is not configured
  (`TELEGRAM_BOT_TOKEN` or `TELEGRAM_BOT_USERNAME` unset). Throttled to 10/min.
- `DELETE /me/telegram` → 204. Unlinks the chat (and drops an unused link token). Idempotent. `DELETE /me` also clears the link.

### Media (owner: accounts agent)
- `POST /media/presign` (auth) `{ contentType: 'image/jpeg'|'image/png'|'image/webp', size: number <= 5_000_000 }` → `{ photoId, uploadUrl, method: 'PUT', headers: Record<string,string> }`.
  With R2/S3 configured: presigned PUT. Without (local dev): `uploadUrl = /api/media/<photoId>/upload` handled by the API, stored under `backend/uploads/`.
  The Photo row is created up front (`confirmed=false`, `approved=false`). Upload key `tmp/<userId>/<photoId>.<ext>`; presigned URL valid 10 min; send the returned `headers`.
- `PUT /media/:id/upload` (auth, dev fallback only) raw body, `Content-Type` must equal the presigned type (415 otherwise), max 5 MB (413). 204. 404 when S3/R2 is configured.
- `POST /media/:id/confirm` (auth, own photo else 404) → `PhotoRef`. Idempotent. Verifies the object exists (400 if not uploaded), size <= 5 MB (413), and that the bytes really are the declared image type (400). Re-encodes the image (auto-rotate, EXIF/GPS stripped) to `photos/<id>.<ext>`, writes a 400px-wide webp thumb to `thumbs/<id>.webp`, deletes the tmp object. Photos still need moderation (`approved=false`).
- `GET /media/photos/:id` and `GET /media/photos/:id/thumb` (optional auth): photo reads. The bucket is private, so every `PhotoRef.url` / `thumbUrl` (and `photoThumb`) is one of these paths, `/api/media/photos/<id>[/thumb]` through the frontend rewrite, never a bucket URL; they are stable and safe to cache in JSON.
  Approved photos: anyone. Not yet approved: the uploader, TRUSTED+, and any signed-in user while the photo's submission is open and not `escalated_flagged` (the same rule as `SubmissionView.photos`). Unconfirmed uploads (`tmp/`), unknown ids, or no thumbnail: 404 (never 403).
  With R2/S3: `302` to a presigned GET on the S3 endpoint. Approved: signed for a fixed 1 h window (valid 2 h), `Cache-Control: public, max-age=<rest of the window>, s-maxage=<same>`. Unapproved: 5 min window (valid 10 min), `Cache-Control: private, no-store`. Local dev storage: `200` with the file, same access rules and `Cache-Control`. Throttle 600/min.

### Submissions (owner: contributions agent)
- `POST /submissions` (auth) `{ kind, toiletId?, lat?, lng?, payload, force?: boolean }` → 201 `SubmissionView`. `lat/lng` = where the submitter stands.
  `payload` is validated per `kind` (discriminated union). There is no separate venue kind: a new place is created through NEW_TOILET's `newVenue`.
  NEW_TOILET: `photoIds` (optional, 0–10) must be the user's own confirmed photos not attached to another submission (400);
  location must be inside Singapore (400). Venue: `venueId`, else `newVenue` creates a COMMUNITY venue, else snaps to the
  nearest venue within 60 m, else creates a COMMUNITY venue (type OTHER, named after `label`).
  `payload.level` is normalised before it is stored (see "Levels"; 400 "level must name a floor, e.g. B1 or L3" when nothing
  is left of it). Level required: with an explicit `venueId` whose venue already has an ACTIVE or PENDING toilet, a missing
  `level` → 400 `{ statusCode, error, message, code: "level_needed" }`, message "This place already has a toilet listed.
  Add the level (for example B1 or L3) so people can tell them apart." (also with `force: true`). Checked under the
  submitter's and the venue's locks, so two people adding at one place at once can't both skip it. Optional otherwise
  (new places, snapped venues). `GET /venues/:id` lists the toilets this counts (ACTIVE and PENDING among them).
  Duplicate guard: an ACTIVE/PENDING toilet within 15 m at the same venue and same level → 409
  `{ statusCode, message, candidateIds: string[], candidates: ToiletSummary[] }`; resend with `force: true` to override.
  Levels are compared normalised ("1", "L1" and "Level 1" match; "B1; L3" matches "L3"); an unknown level matches any.
  Creates a Toilet with tier COMMUNITY, `seenBy = 1`. Trust model v2 decides its status (see "Trust model v2" below):
  on site (lat/lng within 150 m of the pin) + at least one photo → ACTIVE at once, submission APPROVED with `resolution: 'auto_on_site_photo'`,
  NEW_TOILET_SUBMITTED +5 now (badges evaluated); otherwise PENDING (dashed pin). Expires after 60 days (then ESCALATED, never rejected).
  EDIT_TOILET / CLOSE_TOILET need `toiletId` of an ACTIVE toilet (404 / 400). EDIT `changes` must not be empty; `changes.level` is normalised.
  EDIT_TOILET also needs `lat/lng` within 150 m of the toilet (400 when missing or farther): only someone there can edit it.
  429 when the user already has 10 open (PENDING/NEEDS_INFO/ESCALATED) submissions created in the last 14 days
  (older ones do not count). `Me.openSubmissions` exposes `{ count, limit }` so /add can warn up front.
- `GET /submissions/queue?lat&lng&radius=3000` (auth; lat/lng required, radius 50-20000) → `{ items: SubmissionView[] }`
  PENDING/NEEDS_INFO/ESCALATED (escalated ones can still be confirmed nearby; flagged ones are moderator-only and left out),
  not own, within radius of the toilet, nearest first, max 50, `distanceM` filled.
  Includes ones I already voted on (`myVote` set, `canVote` false). `photos` include unapproved ones.
- `GET /submissions/mine` (auth) → `{ items: SubmissionView[] }` newest first, max 100.
- `GET /submissions/:id` (auth) → `SubmissionView` (404). `state` reads `ESCALATED` once an open submission is past `expiresAt`.
  `photos` on any `SubmissionView`: unapproved photos are included while the submission is open (and not `escalated_flagged`), and
  always for the submitter and MODERATOR+; otherwise only approved photos.
- `PATCH /submissions/:id` (auth, owner only, else 404) `{ note?: string 1-1000, photoIds?: string[] (max 10), level?: string 1-20 }`
  (at least one; 400 otherwise) → 200 `SubmissionView`. Only in NEEDS_INFO (409 "Only a submission that needs more info can be changed").
  `note` → `payload.note`; `photoIds` (own confirmed, unattached, else 400) are appended to `payload.photoIds` and attached (hasPhoto updated);
  `level` (normalised) → `payload.level` and the pending toilet's level (NEW_TOILET) or `payload.changes.level` (EDIT_TOILET); 400 for CLOSE_TOILET.
  Effect: state PENDING, REJECT votes deleted (those reviewers can vote again), APPROVE votes kept, `rejections` 0, resolution cleared,
  `expiresAt` = now + 60 days.
- `POST /submissions/:id/votes` (auth) `{ value: 'APPROVE'|'REJECT', comment?, lat?, lng? }` → 201 `SubmissionView`.
  403 own submission; 409 already voted, voting closed (decided), or "A moderator is reviewing this toilet after it was flagged"
  (`escalated_flagged`). Expiry no longer closes voting: ESCALATED submissions can still be voted on. `distanceM` of a vote = voter lat/lng to toilet.
  Quorum (NEW_TOILET/EDIT_TOILET): 2 APPROVE votes cast within 150 m of the toilet, OR 1 APPROVE from TRUSTED+ → APPROVED.
  NEW_TOILET submitted on site (`onSite`): 1 APPROVE within 150 m is enough. A signed-in check-in counts as an APPROVE vote (see check-ins).
  CLOSE_TOILET: 1 APPROVE within 150 m or from TRUSTED+ → APPROVED.
  MODERATOR+ REJECT → REJECTED (wins over approvals). 2 non-moderator REJECT → NEEDS_INFO (still votable).
  On resolution (one transaction): apply (NEW → toilet ACTIVE + lastVerifiedAt; rejected NEW → toilet REJECTED;
  EDIT → fields + features with source COMMUNITY; CLOSE → toilet.status), award SUBMISSION_APPROVED (20) to the submitter
  (NEW_TOILET_CONFIRMED 15 instead if it was auto-published, so the total stays 20) and VOTE_MATCHED_OUTCOME to every voter whose
  vote matched, then badges are evaluated. `resolution` codes: `community_approved`, `confirmed_on_site` (an on-site toilet confirmed
  through a check-in), `trusted_approved`, `moderator_rejected` (moderator REJECT vote), `peer_needs_info`.
- `POST /submissions/:id/resolve` (MODERATOR+) `{ state: 'APPROVED'|'REJECTED'|'NEEDS_INFO', note? }` → 200 `SubmissionView`.
  Same effects as a quorum. Works on PENDING, NEEDS_INFO and ESCALATED. 409 if already APPROVED/REJECTED/EXPIRED.
  `resolution` = `moderator_approved|moderator_rejected|moderator_needs_info`; `note` → `resolutionNote`.

### Trust model v2 (PLAN.md §12 E1)
- New toilet paths (`SubmissionView.path`):
  - `auto`: on site (submitter within 150 m of the pin) + ≥ 1 photo → ACTIVE at once, Community tier, `seenBy = 1`, +5 NEW_TOILET_SUBMITTED.
    The first other signed-in person to check in within 150 m pays the submitter +15 NEW_TOILET_CONFIRMED (check-in shows `confirmedPending: true`).
    Guardrails: max 3 auto-publishes per user per Singapore day, none for 30 days after one of your submissions was REJECTED;
    either falls back to `on_site_check_in`. 2 distinct flaggers → back to PENDING + ESCALATED (`escalated_flagged`), moderator only.
  - `on_site_check_in`: on site, no photo (or a guardrail hit) → PENDING; live on the first check-in (or nearby APPROVE vote) by someone
    else within 150 m, or a TRUSTED+ approve / moderator.
  - `nearby_quorum`: not on site → PENDING; 2 nearby APPROVE (check-ins count), or TRUSTED+ / moderator.
- Expiry: the `expire-submissions` job moves PENDING/NEEDS_INFO past `expiresAt` to ESCALATED (`escalated_expired`) and leaves the toilet
  PENDING (it still shows as unconfirmed and can still be confirmed nearby). It never rejects.
- Points: NEW_TOILET_SUBMITTED +5, NEW_TOILET_CONFIRMED +15 (counts toward trust), SUBMISSION_APPROVED +20 for every other approved submission.
- Trust (`trustScore`, TRUSTED at 50) counts SUBMISSION_APPROVED, NEW_TOILET_CONFIRMED, STATUS_CONFIRMED, VOTE_MATCHED_OUTCOME and
  SURVEY_COMPLETED only. REVIEW_WITH_PHOTO is points only: it is paid before anyone has looked at the photo.
  Points already paid stay if a flagged toilet is later rejected.
- Moderator queue: `GET /admin/submissions` (below).

### Anonymous device (`sgw_anon`, PLAN.md §12 E4)
- Signed-out check-ins and status reports set an httpOnly, SameSite=Lax (Secure in production), path `/`, 1-year cookie `sgw_anon` =
  `<random UUID>.<HMAC-SHA256 with AUTH_SECRET>`, issued on the first anonymous check-in/report. No PII, no coordinates.
  Stored rows keep `deviceId` with `userId = null` until sign-in merges them (see `/auth/callback`), which clears the cookie.
- Adding toilets, edits, reviews, votes, flags and "Still true" confirmations stay signed-in only.

### Gamification (owner: contributions agent)
- `POST /toilets/:id/check-ins` (optional auth) `{ lat, lng }` → 201
  `{ id, distanceM, pointsAwarded: number, newBadges: Badge[], verifyPrompt: Feature[], confirmedPending: boolean, wentLive: boolean, bankedPoints: number }`.
  404 unknown toilet; 400 if > 150 m (message states the distance) or the toilet is CLOSED/RENOVATION/REJECTED; 429 if the user checked in
  at this toilet in the last 2 h. Only `distanceM` is stored, never the coordinates.
  Points: CHECK_IN +1 (max 5 awards per Singapore calendar day) and FIRST_CHECK_IN_AT_TOILET +3 the first time at a toilet.
  Signed in: allowed at ACTIVE and PENDING toilets. The first check-in per person per toilet increments `seenBy` (not the submitter's own).
  At a new toilet someone else added (open submission, or an auto-published one awaiting its second person) it also records an APPROVE vote
  linked to the check-in (if they have not voted) and runs the quorum: `confirmedPending: true` when it counted, `wentLive: true` when that
  put a PENDING toilet live. Not for flagged-escalated ones. `bankedPoints` is 0.
  Signed out: allowed at ACTIVE toilets only (401 "Sign in to confirm a new toilet" at PENDING ones); sets `sgw_anon`; same 150 m rule and
  2 h cooldown per device; max 5 per device per Singapore day (429 "You can check in 5 times a day without signing in. Sign in to keep going.")
  and 30 per IP per day (429). Never votes, never increments `seenBy`, earns nothing now: `pointsAwarded: 0`, `newBadges: []`,
  `bankedPoints` = what the device earned (CHECK_IN 1 + FIRST_CHECK_IN_AT_TOILET 3 for its first time here), paid on sign-in.
  Check-ins (either kind) do not change `lastVerifiedAt`; `POST /toilets/:id/verify` with `accurate: true` does.
  `verifyPrompt`: up to 5 of BIDET, ACCESSIBLE, TOILET_PAPER, FREE, HAND_SOAP, SITTING, BABY_CHANGE — features the listing
  has a value for first, then unknown ones.
- `POST /toilets/:id/verify` (auth) `{ lat, lng, accurate: boolean, note? }` → 200 `{ ok: true }`. Same 150 m rule; 400 for
  PENDING/REJECTED toilets. accurate → lastVerifiedAt=now; not accurate → Flag with reason `Check-in: listing inaccurate - <note>`.
- `GET /me/passport` (auth) → `{ stamped: number; total: number; stations: { venueId, name, lines: string[], stampedAt: string | null }[] }`
  All MRT_STATION venues with toiletStatus HAS_TOILETS, by name. `stampedAt` = the user's earliest check-in at that station.
- `GET /leaderboard/users?scope=week|all` (default `week` = last 7 days, optional auth) → `{ items: { rank, handle, avatarUrl, points }[]; me: { rank: number | null; points: number } | null }` (`avatarUrl` always null)
  Users with a handle and > 0 points who haven't turned the leaderboard off (`leaderboardOptIn`, on by default), top 100.
  Every account gets a random pseudonymous handle at sign-up (never from its Google name or email), so all are listed by default.
  Ties share a rank (1, 2, 2, 4). `items` cached 5 min per scope.
  `me` is null when signed out; `me.rank` is null when the user has turned it off or has no handle.
- `GET /leaderboard/toilets?area=` → `{ items: { rank: number; toilet: ToiletSummary; score: number }[]; areas: string[] }`
  (not implemented by the contributions agent: needs the finder agent's ToiletSummary builder)
- `GET /badges` (optional auth) → `{ items: Badge[] }` every badge; `awardedAt` set on the signed-in user's earned ones.
  Badges are evaluated after check-ins and approvals; other modules can call `GamificationService.evaluateBadges(userId, tx?)`.
  `founding-contributor` ("Founding Contributor", 🌱): one of the first 100 accounts to check in or have a submission approved
  (auto-published counts), awarded on the next evaluation while fewer than 100 accounts hold it. No backfill.

### Admin (owner: accounts agent)
All MODERATOR+ unless noted.
- `GET /admin/flags?resolved=false` → `{ items: { id, reason, createdAt, resolved, toilet: { id, label, venueName }, user: { handle } }[] }` (max 200)
- `POST /admin/flags/:id/resolve` → `{ ok: true }`
- `GET /admin/photos/pending` (TRUSTED+) → `{ items: (PhotoRef & { createdAt, toiletId, submissionId, reviewId, approvals })[] }` confirmed and not yet approved, oldest first, max 100.
- `POST /admin/photos/:id/approve` (TRUSTED+; 1 MODERATOR or 2 TRUSTED approvals publish) → `{ approved: boolean, approvals }`.
  409 if the same user already approved; 403 approving your own photo (ADMIN exempt); already-published → returns `{ approved: true }`.
- `POST /admin/photos/:id/reject` (MODERATOR+) → `{ ok: true }` deletes object.
- `PATCH /admin/toilets/:id` `{ status?, label?: string|null, areaType?, level?: string|null, accessNote?: string|null, needsResurvey?, features?: Partial<Record<Feature,boolean>> }` → `{ id }`. Features are written with `source=ADMIN`, `observedAt=now`. `level` is normalised (`""` clears it). Unknown keys → 400.
- `PATCH /admin/users/:id/role` (ADMIN) `{ role }` → `{ id, role }`. 400 when changing your own role.
- `GET /admin/imports` → `{ items: ImportRun[] }`
- `GET /admin/submissions?state=pending|escalated|needs_info|all` (default `all` = PENDING + NEEDS_INFO + ESCALATED) →
  `{ items: (SubmissionView & { ageDays: number })[] }` island-wide, escalated first then oldest first, max 200. Filters on the view state
  (an overdue PENDING reads ESCALATED). Each item carries kind, toilet/venue names, onSite, hasPhoto, submitterDistanceM, approvals,
  nearbyApprovals, needed, reviewerNotes, photos (incl. unapproved), payload and `current` (edits). Resolve with `POST /submissions/:id/resolve`. 400 bad state.
- `GET /admin/data-quality` → `{ counts: { toilets, venues, pending, escalated, flagsOpen, photosPending, noFeatures, stale365d, needsResurvey, unknownAreaType } }`
- `GET /admin/data-quality`: `toilets` excludes REJECTED; `pending` = unexpired PENDING/NEEDS_INFO submissions; `noFeatures`, `stale365d` (lastVerifiedAt null or > 365 d), `needsResurvey`, `unknownAreaType` count ACTIVE toilets only.
- `GET /admin/metrics?days=30` (1-366) → `{ items: MetricsDay[] }` newest first. `MetricsDay` = `{ day: 'YYYY-MM-DD' (SGT), wac, contributors, checkIns, statusReports, reviews, submissions, votes, freshPct, toiletsByTier: { VERIFIED, COMMUNITY, IMPORTED }, pendingCount }`.
  `contributors` = distinct users or anonymous devices with a check-in, status report, review, submission or vote that day; `wac` = the same over the 7 days ending that day;
  `freshPct` = % of ACTIVE Verified + Community toilets verified within 90 days; tier counts are ACTIVE toilets; `pendingCount` = PENDING toilets.
- `POST /admin/jobs/:name` header `x-cron-secret: CRON_SECRET` (no session, not throttled) name ∈ `expire-submissions | archive-status | recompute-scores | metrics` → `{ ok: true, affected: number }`.
  `metrics` upserts the `MetricsDaily` row for the Singapore day that ended most recently (run at 03:00 SGT); affected = 1.
  401 bad/missing secret, 503 when CRON_SECRET is unset, 404 unknown job. `expire-submissions`: PENDING/NEEDS_INFO past `expiresAt` → ESCALATED (`escalatedAt` set, resolution `escalated_expired`); their toilets stay PENDING; affected = submissions. `escalated` (data-quality) = submissions in ESCALATED. `archive-status`: deletes status reports expired > 7 days. `recompute-scores`: affected = toilets recomputed.

### Telegram bot (BOT.md)
- `POST /integrations/telegram` is the bot's webhook: only when `TELEGRAM_BOT_TOKEN` is set, never throttled, and not in `openapi.json`.
  Requires header `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` (401 otherwise; 503 when the secret is unset).
  Always 200 once authenticated; replies go out through the Bot API before it responds.
- The bot calls the services in-process: check-ins and status reports from unlinked chats use device id `hashTelegramId(chatId)`
  (same anonymous guardrails as `sgw_anon`), linked chats act as the user. Analytics context `{ surface: 'telegram', source: 'telegram' }`.

### Analytics (GROWTH.md 0.1)
- Server-side PostHog events, a no-op unless `POSTHOG_KEY` is set (`POSTHOG_HOST` defaults to the US cloud, where the production project lives). Events never block a response.
- Optional request headers from the web app: `x-sgw-source` (first-touch utm_source, `[a-z0-9-]{1,40}`) and `x-sgw-distinct-id`
  (the browser's PostHog id, `[A-Za-z0-9$:._-]{1,100}`). Malformed values are ignored.
- Distinct id: the user id when signed in; `tg:<hash>` for unlinked Telegram chats; else the browser's id; else `anon:<deviceId>`.
- Events: `checkin`, `status_report` (from the services, so the Telegram bot gets them too), `review`, `submission`, `vote`, `signin`.
  Common props `surface: 'web' | 'telegram'`, `anonymous`, `source?`; plus `toilet_id`, `toilet_tier`, `distance_m` (rounded to 10 m),
  `on_pending`, `kind`, `after_route`, `value`, `on_site`, `method`, `new_user` as relevant. No email, name or coordinates.
