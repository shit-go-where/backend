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
  level: string | null;
  areaType: AreaType;
  tier: ToiletTier;
  status: ToiletStatus;
  features: Feature[];              // features with present=true
  scoreCleanliness: number | null;  // 0-10 blended
  surveyTotal: number | null;       // latest survey total, 0-50
  rasStars: number | null;
  reviewCount: number;
  activeStatus: ActiveStatus[];     // unexpired status reports grouped by kind
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
}

interface Survey {
  id: string; surveyedAt: string; phase: string | null;
  cleanliness: number; scent: number; aesthetics: number; music: number;
  toiletries: number; facilities: number; total: number; rasStars: number | null;
  remarks: string | null;
}

interface Review {
  id: string; cleanliness: number /*1-5*/; comment: string | null; createdAt: string;
  user: { handle: string | null; avatarUrl: string | null };
  photos: PhotoRef[];
}

interface ToiletDetail extends Omit<ToiletSummary, 'venue'> {
  venue: VenueLite & { address: string | null; planningArea: string | null };
  accessNote: string | null;
  nearestExit: string | null;
  openingHours: OpeningHours | null;   // effective (toilet's or venue's)
  featureDetails: { feature: Feature; present: boolean; source: string; observedAt: string }[];
  latestSurvey: Survey | null;
  surveyCount: number;
  reviews: Review[];                   // latest 10
  photos: PhotoRef[];                  // approved only
  myReview: Review | null;             // when signed in
  source: string;                      // DataSource
  attribution: string | null;          // e.g. "© OpenStreetMap contributors" for OSM
}

interface StatusReport { id: string; kind: StatusKind; confirmations: number; createdAt: string; expiresAt: string; confirmedByMe: boolean }

interface Badge { id: string; name: string; description: string; icon: string; awardedAt?: string }

interface Me {
  id: string; email: string; handle: string | null; displayName: string; avatarUrl: string | null;
  role: Role; trustScore: number; leaderboardOptIn: boolean; points: number;
  badges: Badge[]; needsHandle: boolean;
}

interface SubmissionView {
  id: string;
  kind: 'NEW_TOILET' | 'EDIT_TOILET' | 'CLOSE_TOILET';
  state: 'PENDING' | 'APPROVED' | 'REJECTED' | 'NEEDS_INFO' | 'EXPIRED';
  payload: NewToiletPayload | EditToiletPayload | CloseToiletPayload;
  toilet: { id: string; label: string | null; venueName: string; lat: number; lng: number } | null;
  venue: VenueLite | null;
  submittedBy: { handle: string | null };
  approvals: number; rejections: number;
  createdAt: string; expiresAt: string; resolvedAt: string | null; resolution: string | null;
  distanceM?: number;
  myVote: 'APPROVE' | 'REJECT' | null;
  photos: PhotoRef[];
  canVote: boolean;                    // false for own submissions / already resolved
}

interface NewToiletPayload {
  venueId?: string;                       // existing venue, or
  newVenue?: { name: string; type: VenueType };
  label?: string; lat: number; lng: number; level?: string;
  areaType?: AreaType; accessNote?: string;
  features: Partial<Record<Feature, boolean>>;
  photoIds: string[];                     // >= 1
}
interface EditToiletPayload {
  changes: { label?: string; level?: string; areaType?: AreaType; accessNote?: string;
             features?: Partial<Record<Feature, boolean>> };
  photoIds?: string[];
  note?: string;
}
interface CloseToiletPayload { status: 'CLOSED' | 'RENOVATION'; reason: string }
```

## Endpoints

### Health
- `GET /health` → `{ ok: true, db: 'up', time }`

### Toilets (owner: finder agent)
- `GET /toilets/nearby?lat&lng&radius=1000&features=BIDET,ACCESSIBLE&openNow=true&areaType=UNPAID_AREA&tier=VERIFIED,COMMUNITY&limit=50`
  → `{ items: ToiletSummary[] }` sorted by distance. radius max 5000, limit max 200. Only ACTIVE (and PENDING when `includePending=true`).
  Toilets at venues with `toiletStatus=NONE` are never returned (here, in-bounds, recommend). `features` = all must be present.
  `openNow=true` drops only toilets that are definitely closed; unknown hours (`openNow: null`) stay.
- `GET /toilets/in-bounds?minLat&maxLat&minLng&maxLng&features=...&includePending=true` → `{ items: ToiletPin[] }` (cap 3000).
- `GET /toilets/sitemap` → `{ items: { id: string; updatedAt: string }[] }`: every ACTIVE / CLOSED / RENOVATION toilet not at a NONE venue, for the frontend's sitemap.xml.
- `GET /toilets/:id` → `ToiletDetail` (optional auth for `myReview`).
- `GET /toilets/:id/reviews?cursor&limit=20` (limit max 50) → `{ items: Review[], nextCursor }` newest first; `nextCursor` is the last item's id. Public review photos are approved ones only.
- `POST /toilets/:id/reviews` (auth) `{ cleanliness: 1-5, comment?: string<=1000, photoIds?: string[] (max 10) }` → `Review` (201, upsert, one per user per toilet). Awards REVIEW_POSTED, plus REVIEW_WITH_PHOTO if photos.
  `photoIds` must be the caller's own `confirmed` photos not attached to another review/toilet, else 400. When given it is the full set (others are detached); omitted keeps existing photos.
  The response (and `ToiletDetail.myReview`) include the author's not-yet-approved photos.
- `GET /toilets/:id/status` → `{ items: StatusReport[] }` active only.
- `POST /toilets/:id/status` (auth) `{ kind: StatusKind }` → `StatusReport`. TTL 2h, CLOSED_NOW 24h. Same user+toilet+kind within 30 min → returns existing.
- `POST /status/:id/confirm` (auth) → `StatusReport` (200). Extends expiresAt by 1h (max 6h past createdAt, never shortens a 24h CLOSED_NOW). Awards STATUS_CONFIRMED to the original reporter (refId = `${statusReportId}:${confirmerId}`). Own report → 400; unknown/expired → 404; confirming twice is a no-op returning the report.
  Rate limits: POST status 10/min, confirm 30/min, flags 5/min (per client IP, via @nestjs/throttler).
- `POST /toilets/:id/flags` (auth) `{ reason: string 3-500 }` → `{ id }`

### Venues (owner: finder agent)
- `GET /venues/nearby?lat&lng&radius=1000` → `{ items: (VenueLite & { distanceM: number; toiletCount: number })[] }` includes NONE / USES_NEARBY venues. `toiletCount` = ACTIVE toilets (always 0 for NONE venues).
- `GET /venues/search?q&lat?&lng?` → `{ items: VenueLite[] }` (name ILIKE, max 20, nearest first when lat/lng given).
- `GET /venues/:id` → `VenueLite & { address, planningArea, toilets: ToiletSummary[] }`

### Areas (browse by URA planning area)
- `AreaSummary` = `{ slug, name, region: 'CENTRAL'|'EAST'|'NORTH'|'NORTH_EAST'|'WEST'|null, toiletCount, verifiedCount, venueCount, indexable }`.
  `slug` is the kebab-cased `Venue.planningArea` ("Downtown Core" → `downtown-core`). Counts are ACTIVE toilets not at NONE venues.
  `indexable` = `toiletCount >= 3`; thinner area pages render but are `noindex` and left out of the sitemap.
- `GET /areas` → `{ items: AreaSummary[] }` A to Z, areas with at least one ACTIVE toilet.
- `GET /areas/:slug` → `AreaSummary & { pendingCount, center: { lat, lng } | null, venues: AreaVenue[], noToiletVenues: VenueLite[] }`, 404 for an unknown slug.
  `AreaVenue` = `VenueLite & { address, near: { name, type, distanceM } | null, toilets: ToiletSummary[] }`: places with ACTIVE / CLOSED / RENOVATION
  toilets (never PENDING), best toilet first (open, then tier, then cleanliness), places ranked by their best toilet. `near` is the closest
  non-OTHER place within 1.5 km (in any area), set only when the place has no address. `center` is the area's namesake MRT station, else the
  listed place nearest the middle. `noToiletVenues` are NONE / USES_NEARBY places in the area.

### Routing (owner: finder agent)
- `POST /routing/recommend` `{ lat, lng, urgent?: boolean, purpose?: Purpose, require?: Feature[], areaType?: AreaType, openNow?: boolean, radiusM?: number (default 1500, urgent 800 then widen), weights?: { distance?: number; cleanliness?: number; freshness?: number } }`
  → `{ items: { toilet: ToiletSummary; score: number; walkSeconds: number; walkDistanceM: number; reasons: string[]; route: { polyline: [number, number][]; source: 'onemap' | 'estimate' } | null }[]; searchedRadiusM: number; skippedVenues: { name: string; toiletStatus: VenueToiletStatus; note: string | null; distanceM: number }[] }`
  `purpose` adds soft preferences (src/routing/purposes.ts): missing features add cost, nothing is filtered out.
  Top 3. Toilets that are definitely closed now (openNow === false) are never recommended; unknown hours stay eligible. Route only computed for the top 3 via OneMap when configured; else `route: null` and `walkSeconds` / `walkDistanceM` are estimates (straight line × 1.3).
  `score` is 0-100, higher = better. Hard filters (also in urgent mode): `require`, `areaType`, `openNow` (definitely-closed only), ACTIVE only,
  no unexpired CLOSED_NOW/BROKEN report that is confirmed or reported twice. Urgent: radius 800 → 1500 → 3000 until ≥1 result, `radiusM`/`weights` ignored.
  Reasons look like `"4 min walk"`, `"Bidet"`, `"Clean 8.2/10"`, `"Reported: no paper 40 min ago"`, `"Verified 2024 survey"`. `skippedVenues` max 10, nearest first.
- `GET /routing/walk?fromLat&fromLng&toLat&toLng` → `{ distanceM, durationS, polyline: [lat,lng][], source }`. Without OneMap (or on failure/timeout 4 s) `source: 'estimate'` with a 2-point straight polyline. Never 5xx.
- `GET /geo/search?q` → `{ items: { name: string; address: string; lat: number; lng: number }[] }` (OneMap search proxy, no token needed). Max 10; `[]` when OneMap fails.

### Auth & me (owner: accounts agent)
- `GET /auth/google?redirect=/path` → 302 to Google. State cookie (`sgw_oauth`, httpOnly, signed, 10 min) for CSRF.
  `redirect` must be a relative path starting with `/` (not `//`), else 400. 503 when Google env vars are missing.
- `GET /auth/callback?code&state` → sets `sgw_session`, 302 to `PUBLIC_APP_URL + redirect`. Emails in ADMIN_EMAILS become ADMIN.
  Missing/mismatched state → 400. If the user cancels at Google or sign-in fails, 302 to `PUBLIC_APP_URL + redirect`
  with `?authError=access_denied|no_code|google_failed|email_unverified` and no session.
- `POST /auth/logout` → 204, clears cookie.
- `POST /auth/dev-login` `{ email, displayName? }` → `Me`. Only when `DEV_LOGIN_ENABLED=true` (404 otherwise).
- `GET /me` → `Me` (401 if signed out).
- `PATCH /me` `{ handle?: /^[a-z0-9_]{3,20}$/, displayName?: string 1-50, leaderboardOptIn?: boolean }` → `Me` (409 on handle taken or reserved, e.g. `admin`, `sgw`). Handle is trimmed and lowercased before validation.
- `DELETE /me` → 204, clears cookie. Anonymises the user row (email `deleted-<id>@deleted.invalid`, no handle/avatar/googleSub, "Deleted user", role USER, trust 0) and deletes their check-ins, points ledger and badges. Reviews, submissions, votes, photos, status reports and flags stay, attributed to the anonymous user.
- `GET /me/activity?cursor&limit=30` (limit max 100) → `{ items: { id, delta, reason, refId, createdAt }[], nextCursor }` newest first.

### Media (owner: accounts agent)
- `POST /media/presign` (auth) `{ contentType: 'image/jpeg'|'image/png'|'image/webp', size: number <= 5_000_000 }` → `{ photoId, uploadUrl, method: 'PUT', headers: Record<string,string> }`.
  With R2/S3 configured: presigned PUT. Without (local dev): `uploadUrl = /api/media/<photoId>/upload` handled by the API, stored under `backend/uploads/`.
  The Photo row is created up front (`confirmed=false`, `approved=false`). Upload key `tmp/<userId>/<photoId>.<ext>`; presigned URL valid 10 min; send the returned `headers`.
- `PUT /media/:id/upload` (auth, dev fallback only) raw body, `Content-Type` must equal the presigned type (415 otherwise), max 5 MB (413). 204. 404 when S3/R2 is configured.
- `POST /media/:id/confirm` (auth, own photo else 404) → `PhotoRef`. Idempotent. Verifies the object exists (400 if not uploaded), size <= 5 MB (413), and that the bytes really are the declared image type (400). Re-encodes the image (auto-rotate, EXIF/GPS stripped) to `photos/<id>.<ext>`, writes a 400px-wide webp thumb to `thumbs/<id>.webp`, deletes the tmp object. Photos still need moderation (`approved=false`).
- `GET /media/files/*` (dev fallback only) serves local `photos/` and `thumbs/`; URLs are returned as `/api/media/files/<key>`.

### Submissions (owner: contributions agent)
- `POST /submissions` (auth) `{ kind, toiletId?, lat?, lng?, payload, force?: boolean }` → 201 `SubmissionView`. `lat/lng` = where the submitter stands.
  `payload` is validated per `kind` (discriminated union). There is no separate venue kind: a new place is created through NEW_TOILET's `newVenue`.
  NEW_TOILET: `photoIds` (>= 1) must be the user's own confirmed photos not attached to another submission (400);
  location must be inside Singapore (400). Venue: `venueId`, else `newVenue` creates a COMMUNITY venue, else snaps to the
  nearest venue within 60 m, else creates a COMMUNITY venue (type OTHER, named after `label`).
  Duplicate guard: an ACTIVE/PENDING toilet within 15 m at the same venue and same level (unknown level matches any)
  → 409 `{ statusCode, message, candidateIds: string[], candidates: ToiletSummary[] }`; resend with `force: true` to override.
  Creates a Toilet with status PENDING, tier COMMUNITY, so it can show as a dashed pin. Expires after 60 days.
  EDIT_TOILET / CLOSE_TOILET need `toiletId` of an ACTIVE toilet (404 / 400). EDIT `changes` must not be empty.
  EDIT_TOILET also needs `lat/lng` within 150 m of the toilet (400 when missing or farther): only someone there can edit it.
  429 when the user already has 10 open (PENDING/NEEDS_INFO, unexpired) submissions.
- `GET /submissions/queue?lat&lng&radius=3000` (auth; lat/lng required, radius 50-20000) → `{ items: SubmissionView[] }`
  PENDING/NEEDS_INFO, unexpired, not own, within radius of the toilet, nearest first, max 50, `distanceM` filled.
  Includes ones I already voted on (`myVote` set, `canVote` false). `photos` include unapproved ones.
- `GET /submissions/mine` (auth) → `{ items: SubmissionView[] }` newest first, max 100.
- `GET /submissions/:id` (auth) → `SubmissionView` (404). `state` reads `EXPIRED` once an open submission is past `expiresAt`.
- `POST /submissions/:id/votes` (auth) `{ value: 'APPROVE'|'REJECT', comment?, lat?, lng? }` → 201 `SubmissionView`.
  403 own submission; 409 already voted or voting closed (resolved/expired). `distanceM` of a vote = voter lat/lng to toilet.
  Quorum (NEW_TOILET/EDIT_TOILET): 2 APPROVE votes cast within 150 m of the toilet, OR 1 APPROVE from TRUSTED+ → APPROVED.
  CLOSE_TOILET: 1 APPROVE within 150 m or from TRUSTED+ → APPROVED.
  MODERATOR+ REJECT → REJECTED (wins over approvals). 2 non-moderator REJECT → NEEDS_INFO (still votable).
  On resolution (one transaction): apply (NEW → toilet ACTIVE + lastVerifiedAt; rejected NEW → toilet REJECTED;
  EDIT → fields + features with source COMMUNITY; CLOSE → toilet.status), award SUBMISSION_APPROVED to the submitter
  and VOTE_MATCHED_OUTCOME to every voter whose vote matched, then badges are evaluated.
- `POST /submissions/:id/resolve` (MODERATOR+) `{ state: 'APPROVED'|'REJECTED'|'NEEDS_INFO', note? }` → 200 `SubmissionView`.
  Same effects as a quorum. 409 if already APPROVED/REJECTED/EXPIRED.

### Gamification (owner: contributions agent)
- `POST /toilets/:id/check-ins` (auth) `{ lat, lng }` → 201 `{ id, distanceM, pointsAwarded: number, newBadges: Badge[], verifyPrompt: Feature[] }`.
  404 unknown toilet; 400 if > 150 m (message states the distance) or the toilet is not ACTIVE; 429 if the user checked in
  at this toilet in the last 2 h. Only `distanceM` is stored, never the coordinates.
  Points: CHECK_IN +1 (max 5 awards per Singapore calendar day) and FIRST_CHECK_IN_AT_TOILET +3 the first time at a toilet.
  `verifyPrompt`: up to 5 of BIDET, ACCESSIBLE, TOILET_PAPER, HAND_SOAP, SITTING, SQUAT, BABY_CHANGE — features the listing
  has a value for first, then unknown ones.
- `POST /toilets/:id/verify` (auth) `{ lat, lng, accurate: boolean, note? }` → 200 `{ ok: true }`. Same 150 m rule; 400 for
  PENDING/REJECTED toilets. accurate → lastVerifiedAt=now; not accurate → Flag with reason `Check-in: listing inaccurate - <note>`.
- `GET /me/passport` (auth) → `{ stamped: number; total: number; stations: { venueId, name, lines: string[], stampedAt: string | null }[] }`
  All MRT_STATION venues with toiletStatus HAS_TOILETS, by name. `stampedAt` = the user's earliest check-in at that station.
- `GET /leaderboard/users?scope=week|all` (default `week` = last 7 days, optional auth) → `{ items: { rank, handle, avatarUrl, points }[]; me: { rank: number | null; points: number } | null }`
  Opt-in users with a handle and > 0 points, top 100. Ties share a rank (1, 2, 2, 4). `items` cached 5 min per scope.
  `me` is null when signed out; `me.rank` is null when the user is not opted in.
- `GET /leaderboard/toilets?area=` → `{ items: { rank: number; toilet: ToiletSummary; score: number }[]; areas: string[] }`
  (not implemented by the contributions agent: needs the finder agent's ToiletSummary builder)
- `GET /badges` (optional auth) → `{ items: Badge[] }` every badge; `awardedAt` set on the signed-in user's earned ones.
  Badges are evaluated after check-ins and approvals; other modules can call `GamificationService.evaluateBadges(userId, tx?)`.

### Admin (owner: accounts agent)
All MODERATOR+ unless noted.
- `GET /admin/flags?resolved=false` → `{ items: { id, reason, createdAt, resolved, toilet: { id, label, venueName }, user: { handle } }[] }` (max 200)
- `POST /admin/flags/:id/resolve` → `{ ok: true }`
- `GET /admin/photos/pending` (TRUSTED+) → `{ items: (PhotoRef & { createdAt, toiletId, submissionId, reviewId, approvals })[] }` confirmed and not yet approved, oldest first, max 100.
- `POST /admin/photos/:id/approve` (TRUSTED+; 1 MODERATOR or 2 TRUSTED approvals publish) → `{ approved: boolean, approvals }`.
  409 if the same user already approved; 403 approving your own photo (ADMIN exempt); already-published → returns `{ approved: true }`.
- `POST /admin/photos/:id/reject` (MODERATOR+) → `{ ok: true }` deletes object.
- `PATCH /admin/toilets/:id` `{ status?, label?: string|null, areaType?, level?: string|null, accessNote?: string|null, needsResurvey?, features?: Partial<Record<Feature,boolean>> }` → `{ id }`. Features are written with `source=ADMIN`, `observedAt=now`. Unknown keys → 400.
- `PATCH /admin/users/:id/role` (ADMIN) `{ role }` → `{ id, role }`. 400 when changing your own role.
- `GET /admin/imports` → `{ items: ImportRun[] }`
- `GET /admin/data-quality` → `{ counts: { toilets, venues, pending, flagsOpen, photosPending, noFeatures, stale365d, needsResurvey, unknownAreaType } }`
- `GET /admin/data-quality`: `toilets` excludes REJECTED; `pending` = unexpired PENDING/NEEDS_INFO submissions; `noFeatures`, `stale365d` (lastVerifiedAt null or > 365 d), `needsResurvey`, `unknownAreaType` count ACTIVE toilets only.
- `POST /admin/jobs/:name` header `x-cron-secret: CRON_SECRET` (no session, not throttled) name ∈ `expire-submissions | archive-status | recompute-scores` → `{ ok: true, affected: number }`.
  401 bad/missing secret, 503 when CRON_SECRET is unset, 404 unknown job. `expire-submissions`: PENDING/NEEDS_INFO past `expiresAt` → EXPIRED (their PENDING toilets → REJECTED), affected = submissions. `archive-status`: deletes status reports expired > 7 days. `recompute-scores`: affected = toilets recomputed.
