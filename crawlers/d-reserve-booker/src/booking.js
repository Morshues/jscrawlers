/**
 * Booking, up to the point where a human has to pay.
 *
 *   login            GET  /guest-reserve-front/sso/login  -> Keycloak form
 *                    POST /auth/realms/{group}/login-actions/authenticate
 *   loadCandidate    GET  /guest-reserve-front/GRES001F02100/GRES001A01?...
 *   submitEntry      POST /guest-reserve-front/reservation/entry  -> { nextUrl }
 *
 * `nextUrl` is the JTB Book&Pay card page. Everything before it is plain HTTP;
 * the card form and the issuer's 3-D Secure challenge after it need the
 * cardholder, which is why this module stops there.
 *
 * The booking page is server-rendered and embeds what the front end would
 * otherwise fetch: `window.$csrfToken`, `window.$authenticatedMember` and
 * `window.$initialData.candidateSet`, which is already most of the entry body.
 * `buildEntryPayload` mirrors what the site's own bundle does to it before
 * posting (reserve.bundle.js `Oc`, chunk 119 `entry`).
 */

const CONTEXT = '/guest-reserve-front';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REDIRECTS = 10;

/**
 * Just enough of a cookie jar for one host. Keycloak and the booking front end
 * both live on d-reserve.jp, so cookies are keyed by name alone; sending a
 * /auth-scoped cookie to /guest-reserve-front is harmless.
 */
export function createCookieJar() {
  const cookies = new Map();
  return {
    store(response) {
      for (const line of response.headers.getSetCookie()) {
        const [pair, ...attributes] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attributes.some((attribute) => {
          const [key, raw] = attribute.split('=').map((part) => part?.trim());
          if (/^max-age$/i.test(key)) return Number(raw) <= 0;
          if (/^expires$/i.test(key)) return Date.parse(raw) < Date.now();
          return false;
        });
        if (expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    names() {
      return [...cookies.keys()];
    },
  };
}

/**
 * fetch() that carries the jar and follows redirects by hand: with
 * `redirect: 'follow'` the Set-Cookie headers of every intermediate hop are
 * lost, and the Keycloak handshake is nothing but intermediate hops.
 */
async function request(jar, url, { method = 'GET', headers = {}, body, logger, signal } = {}) {
  let current = url;
  let init = { method, body };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    logger?.debug(`${init.method} ${current.split('?')[0]}`);
    const response = await fetch(current, {
      ...init,
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': USER_AGENT,
        'accept-language': 'zh-TW,zh;q=0.9,ja;q=0.8,en;q=0.7',
        ...headers,
        cookie: jar.header(),
      },
    });
    jar.store(response);

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) {
      return { response, url: current };
    }
    await response.body?.cancel();
    current = new URL(location, current).href;
    // 307/308 would replay the body; nothing on this path uses them.
    init = { method: 'GET' };
  }
  throw new Error(`too many redirects starting from ${url.split('?')[0]}`);
}

export function bookingPageUrl(config, { roomCode, planCode, date }) {
  const url = new URL(`${CONTEXT}/GRES001F02100/GRES001A01`, config.apiBase);
  const params = {
    rmcd001: roomCode,
    ci: date.replaceAll('-', ''),
    hotelCode: config.hotelCode,
    pl: planCode,
    sumrm: '1',
    rm001: '1',
    lt001: config.query.lodgerCode,
    lnum001: config.query.lodgerNum,
    stay: config.query.stays,
    dayuse: 'N',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/** The `action` of Keycloak's login form, or null when the page is not one. */
export function parseLoginForm(html) {
  const match = html.match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/);
  return match ? match[1].replaceAll('&amp;', '&') : null;
}

/** Keycloak renders a failed login as the same form plus an alert. */
function loginError(html) {
  const match = html.match(
    /class="[^"]*(?:kc-feedback-text|alert-error|pf-m-danger)[^"]*"[^>]*>([^<]+)</,
  );
  return match?.[1]?.trim() || null;
}

/**
 * Sign in and land on `returnUrl`. Returns the jar plus that page's HTML, so
 * logging in straight onto the booking page costs no extra request.
 */
export async function login(config, { returnUrl, logger, signal }) {
  const { username, password } = config.booking;
  if (!username || !password) {
    throw new Error('BOOKER_LOGIN_USER and BOOKER_LOGIN_PASSWORD must be set to book');
  }

  const jar = createCookieJar();
  const start = new URL(`${CONTEXT}/sso/login`, config.apiBase);
  start.searchParams.set('hotelCode', config.hotelCode);
  start.searchParams.set('return_url', returnUrl);
  start.searchParams.set('ui_locales', 'zh-TW');

  const form = await request(jar, start.href, { logger, signal });
  const formHtml = await form.response.text();
  const action = parseLoginForm(formHtml);
  if (!action) {
    throw new Error(
      `expected the Keycloak login form, got HTTP ${form.response.status} at ${form.url.split('?')[0]}`,
    );
  }

  const landed = await request(jar, new URL(action, form.url).href, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: form.url },
    body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
    logger,
    signal,
  });
  const html = await landed.response.text();
  if (parseLoginForm(html)) {
    throw new Error(`login rejected: ${loginError(html) ?? 'still on the login form'}`);
  }
  if (!landed.response.ok) {
    throw new Error(`login ended on HTTP ${landed.response.status} at ${landed.url.split('?')[0]}`);
  }
  logger?.debug(`logged in, cookies: ${jar.names().join(', ')}`);
  return { jar, html, url: landed.url };
}

/**
 * Read one `window.$name = <json>;` statement from the booking page. Each sits
 * on its own line and JSON cannot contain a raw newline, so the line is the value.
 */
export function readPageGlobal(html, name) {
  const marker = `window.$${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) return undefined;
  const end = html.indexOf('\n', start);
  const literal = html
    .slice(start + marker.length, end < 0 ? undefined : end)
    .trim()
    .replace(/;$/, '');
  return JSON.parse(literal);
}

export function parseBookingPage(html) {
  const csrfToken = readPageGlobal(html, 'csrfToken');
  const initialData = readPageGlobal(html, 'initialData');
  const candidateSet = initialData?.candidateSet;
  if (!csrfToken || !candidateSet) {
    const conflict = initialData?.conflictExceptionForCandidateSet;
    throw new Error(
      conflict
        ? `booking page refused the candidate: ${JSON.stringify(conflict)}`
        : 'booking page has no csrfToken/candidateSet — the page layout may have changed',
    );
  }
  return {
    csrfToken,
    candidateSet,
    member: readPageGlobal(html, 'authenticatedMember') ?? initialData.authenticatedMember ?? null,
  };
}

/** The site's getAuthenticatedReserver(). */
export function reserverFromMember(member) {
  return {
    reserverCode: member.id,
    member: true,
    name: member.name,
    nameKana: member.nameKana,
    gender: member.gender,
    email: member.email,
    phoneNumber: member.phoneNumber,
    address: member.address,
    livingAbroad: member.address == null || member.address.countryCode !== 'JP',
    birthdate: member.birthdate,
    locale: member.locale,
  };
}

/**
 * Fill the questionnaire from `BOOKER_ANSWERS` ("8153=0,8154=山梨").
 * A required question with no answer is an error rather than a guess: it names
 * the question and its choices so the fix is one line of .env.
 */
export function answerQuestions(forms = [], answers = {}) {
  return forms.map((form) => {
    const given = answers[form.code];
    const filled = { ...form, answerText: null, answerItemValues: null };
    if (form.formType === 'TEXT') filled.answerText = given ?? null;
    else if (given != null) filled.answerItemValues = String(given).split('|');

    const answered = filled.answerText || filled.answerItemValues?.length;
    if (form.required && !answered) {
      const choices = (form.items ?? []).map((item) => `${item.value}=${item.label}`).join(', ');
      throw new Error(
        `question ${form.code}「${form.title}」is required: set BOOKER_ANSWERS=${form.code}=<value>` +
          (choices ? ` (${choices})` : ''),
      );
    }
    return filled;
  });
}

/** `${date}T${HH:mm}:00+09:00` — every d-reserve hotel is in Japan. */
function checkInDateTime(date, time) {
  return `${date}T${time}:00+09:00`;
}

/**
 * The entry body, as the site's own front end builds it for a signed-in member
 * paying by card through JTB (payment agent JBI).
 *
 * Only ADULT gender counts are asked of the user; everyone else is booked as
 * "other", which the form also allows.
 */
export function buildEntryPayload(
  { candidateSet, member },
  { apiBase, answers = {}, genders = {}, refererUrl },
) {
  if (!member) throw new Error('not signed in: the booking page has no authenticatedMember');

  const reserver = reserverFromMember(member);
  const payment = candidateSet.paymentMethods?.find((method) => method.type === 'CREDIT_CARD');
  if (!payment) throw new Error('this plan offers no CREDIT_CARD payment');
  if (payment.agent !== 'JBI') {
    throw new Error(`card payments go through ${payment.agent}, not JTB (JBI); not supported`);
  }

  const reservations = structuredClone(candidateSet.reservations).map((reservation) => {
    const time = reservation.planDetails?.defaultCheckInTime ?? '15:00';
    reservation.memberReserver = true;
    reservation.checkInTime = time;
    reservation.checkInDateTime ??= checkInDateTime(reservation.checkInDate, time);
    reservation.paymentType = 'CREDIT_CARD';
    reservation.questionForms = answerQuestions(reservation.questionForms, answers).map((form) => ({
      ...form,
      title: null,
      comment: null,
      items: form.items?.map((item) => ({ ...item, label: null })),
    }));
    reservation.options = (reservation.options ?? []).filter((option) => !option.disabled);
    reservation.planDetails = null;
    reservation.cancellationPolicyDetails = null;
    delete reservation.couponDiscountsForRegularPrice;
    delete reservation.couponDiscountForRegularPriceTotal;
    delete reservation.acquirableCoupons;
    delete reservation.notApplicableCoupons;

    for (const roomType of reservation.roomTypes) {
      roomType.roomTypeDetails = null;
      for (const room of roomType.rooms) {
        if (room.lodgerRepresentativeSameAsReserver) room.lodgerRepresentative = reserver;
        room.lodgerTypeGenderBreakdowns = room.lodgerTypeGenderBreakdowns
          .filter((entry) => entry.numberOfLodgers > 0)
          .map((entry) => splitGenders(entry, entry.lodgerType === 'ADULT' ? genders : {}));
        for (const day of room.roomChargesPerDay) {
          if (day.planSalesUnit === 'LODGER') {
            day.lodgerTypeBreakdowns = day.lodgerTypeBreakdowns.filter(
              (entry) => entry.numberOfLodgers > 0,
            );
          }
        }
      }
    }
    return reservation;
  });

  const amount = candidateSet.grandTotalCharge;
  return {
    termsAndConditionsCode: candidateSet.termsAndConditions.code,
    privacyPolicyLastUpdated: candidateSet.privacyPolicy.lastUpdated,
    paymentParameters: {
      reserveConfirmationUrl: myPageUrl(apiBase, candidateSet),
    },
    reservationGroup: {
      hotelGroupCode: candidateSet.hotelGroupCode,
      hotelCode: candidateSet.hotelCode,
      reservations,
      reserver,
      contractCompany: null,
      payment: { method: payment, usePoints: 0, amount },
    },
    referer: refererUrl,
    registeredMemberId: null,
  };
}

function splitGenders(entry, { males = 0, females = 0 }) {
  const numberOfMales = Math.min(males, entry.numberOfLodgers);
  const numberOfFemales = Math.min(females, entry.numberOfLodgers - numberOfMales);
  return {
    ...entry,
    numberOfMales,
    numberOfFemales,
    numberOfOthers: entry.numberOfLodgers - numberOfMales - numberOfFemales,
  };
}

/** Where JTB sends the guest after paying: the member's reservation list. */
function myPageUrl(apiBase, candidateSet) {
  const account = new URL(
    `/auth/realms/directin-s4/cdp/groups/${candidateSet.hotelGroupCode}/redirects/account`,
    apiBase,
  );
  account.searchParams.set('page', '/directin-s4/reservation');
  const url = new URL(`${CONTEXT}/sso/login`, apiBase);
  url.searchParams.set('hotelCode', candidateSet.hotelCode);
  url.searchParams.set('return_url', account.href);
  url.searchParams.set('ui_locales', 'zh-TW');
  return url.href;
}

/** POST the entry. Success and most failures both answer with `nextUrl`. */
export async function submitEntry(config, { jar, csrfToken, payload, logger, signal }) {
  const url = new URL(`${CONTEXT}/reservation/entry`, config.apiBase);
  url.searchParams.set('hotelCode', config.hotelCode);

  const { response } = await request(jar, url.href, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: new URL(config.apiBase).origin,
      referer: payload.referer,
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(payload),
    logger,
    signal,
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { ok: response.ok, status: response.status, nextUrl: body.nextUrl ?? null, body };
}

/** Enough of the payload to eyeball in a log without printing who is booking. */
export function summarizePayload(payload) {
  const group = payload.reservationGroup;
  return group.reservations.map((reservation) => ({
    plan: reservation.planCode,
    checkIn: reservation.checkInDateTime,
    checkOut: reservation.checkOutDate,
    rooms: reservation.roomTypes.map((roomType) => ({
      room: roomType.roomTypeCode,
      lodgers: roomType.rooms.map((room) =>
        room.lodgerTypeGenderBreakdowns
          .map((entry) => `${entry.lodgerType}×${entry.numberOfLodgers}`)
          .join(' '),
      ),
    })),
    answers: reservation.questionForms.map(
      (form) => `${form.code}=${form.answerText ?? form.answerItemValues?.join('|') ?? ''}`,
    ),
    total: reservation.totalChargeToPay,
    cancellationPolicy: reservation.cancellationPolicyCode,
    reserver: mask(group.reserver.email),
    payment: `${group.payment.method.type}/${group.payment.method.agent} ¥${group.payment.amount}`,
  }));
}

function mask(value) {
  const text = String(value ?? '');
  return text.length <= 4 ? '****' : `${text.slice(0, 2)}***${text.slice(-2)}`;
}

/**
 * One booking attempt for one cell, start to `nextUrl`.
 *
 * Never throws: book mode runs alongside the alert, and a failed attempt is
 * something to report and maybe retry next poll, not a reason to end the poll.
 * `payload` is returned even on failure so the caller can keep it for diagnosis.
 *
 * @returns {Promise<{ ok: boolean, submitted: boolean, nextUrl?: string|null,
 *   payload?: object, response?: object, error?: string }>}
 */
export async function attemptBooking(config, cell, { dryRun = false, logger, signal } = {}) {
  let payload;
  try {
    const pageUrl = bookingPageUrl(config, {
      roomCode: cell.roomCode,
      planCode: cell.planCode,
      date: cell.salesDate,
    });
    const { jar, html } = await login(config, { returnUrl: pageUrl, logger, signal });
    const page = parseBookingPage(html);
    payload = buildEntryPayload(page, {
      apiBase: config.apiBase,
      answers: config.booking.answers,
      genders: config.booking.genders,
      refererUrl: `${pageUrl}&restore=true`,
    });

    const total = payload.reservationGroup.payment.amount;
    if (config.booking.maxPrice !== null && total > config.booking.maxPrice) {
      return {
        ok: false,
        submitted: false,
        payload,
        error: `total ¥${total} is over the cap ¥${config.booking.maxPrice}`,
      };
    }
    if (dryRun) return { ok: true, submitted: false, payload };

    const response = await submitEntry(config, {
      jar,
      csrfToken: page.csrfToken,
      payload,
      logger,
      signal,
    });
    return {
      ok: response.ok && Boolean(response.nextUrl),
      submitted: true,
      nextUrl: response.nextUrl,
      payload,
      response,
      error: response.ok
        ? undefined
        : `HTTP ${response.status}: ${describeEntryError(response.body)}`,
    };
  } catch (error) {
    return { ok: false, submitted: false, payload, error: error.message };
  }
}

/** The entry endpoint's error body, reduced to something fit for a chat message. */
function describeEntryError(body) {
  const codes = (body?.errors ?? []).map((entry) => entry.message ?? entry.code).filter(Boolean);
  if (codes.length > 0) return codes.join('; ');
  return body?.message ?? JSON.stringify(body).slice(0, 300);
}
