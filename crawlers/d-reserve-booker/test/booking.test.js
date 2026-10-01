import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCookieJar,
  parseLoginForm,
  readPageGlobal,
  parseBookingPage,
  buildEntryPayload,
  answerQuestions,
} from '../src/booking.js';

const MEMBER = {
  id: 'member-1',
  name: { familyName: 'Lai', givenName: 'Test' },
  nameKana: { familyName: 'Lai', givenName: 'Test' },
  gender: 'MALE',
  email: 'someone@example.com',
  phoneNumber: { countryCode: '886', number: '+886-900-000-000' },
  address: { countryCode: null, city: 'Taipei' },
  birthdate: '1990-01-01',
  locale: 'zh_TW',
};

function candidateSet() {
  return {
    hotelGroupCode: 'M000000826',
    hotelCode: '0000001834',
    termsAndConditions: { code: 'ARG1', content: '…' },
    privacyPolicy: { lastUpdated: '2024-06-02T11:59:50.977+09:00', content: '…' },
    grandTotalCharge: 66000,
    paymentMethods: [
      { type: 'CREDIT_CARD', agent: 'JBI', creditCardPaymentProperties: {} },
      { type: 'WBF', agent: 'WBF' },
    ],
    reservations: [
      {
        planCode: 'PL1',
        planDetails: { defaultCheckInTime: '15:00' },
        cancellationPolicyCode: 'CP1',
        cancellationPolicyDetails: { code: 'CP1' },
        checkInDate: '2026-10-29',
        checkInDateTime: null,
        checkOutDate: '2026-10-30',
        acquirableCoupons: [],
        notApplicableCoupons: [],
        couponDiscountsForRegularPrice: [],
        couponDiscountForRegularPriceTotal: 0,
        options: [],
        totalChargeToPay: 66000,
        questionForms: [
          {
            code: 8153,
            formType: 'SELECT_ONE',
            title: '交通手段',
            comment: '',
            required: true,
            items: [
              { value: 0, label: '公共交通機関' },
              { value: 1, label: '自家用車' },
            ],
          },
          { code: 8154, formType: 'TEXT', title: '都道府県名', required: false, items: [] },
        ],
        roomTypes: [
          {
            roomTypeCode: 'RM1',
            roomTypeDetails: { name: '和洋室' },
            rooms: [
              {
                lodgerRepresentative: null,
                lodgerRepresentativeSameAsReserver: true,
                lodgerTypeGenderBreakdowns: [
                  { lodgerType: 'ADULT', numberOfLodgers: 2 },
                  { lodgerType: 'CHILD_A', numberOfLodgers: 0 },
                ],
                roomChargesPerDay: [
                  {
                    planSalesUnit: 'LODGER',
                    lodgerTypeBreakdowns: [
                      { lodgerType: 'ADULT', numberOfLodgers: 2 },
                      { lodgerType: 'CHILD_A', numberOfLodgers: 0 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function page({ member = null, set = candidateSet(), conflict = null } = {}) {
  const initialData = {
    candidateSet: set,
    authenticatedMember: member,
    conflictExceptionForCandidateSet: conflict,
  };
  return [
    '<script>',
    `        window.$contextPath = "\\/guest-reserve-front";`,
    `        window.$authenticatedMember = ${JSON.stringify(member)};`,
    `        window.$initialData = ${JSON.stringify(initialData)};`,
    `        window.$csrfToken = "csrf-1";`,
    '        if (window.$initialData == null) {',
    '            window.$initialData = {};',
    '</script>',
  ].join('\n');
}

const OPTIONS = {
  apiBase: 'https://d-reserve.jp',
  answers: { 8153: '0' },
  genders: { males: 1, females: 1 },
  refererUrl: 'https://d-reserve.jp/guest-reserve-front/GRES001F02100/GRES001A01?restore=true',
};

test('createCookieJar keeps the latest value and drops expired cookies', () => {
  const jar = createCookieJar();
  const response = (...lines) => ({ headers: { getSetCookie: () => lines } });
  jar.store(response('A=1; Path=/', 'B=2; HttpOnly'));
  jar.store(response('A=3; Path=/auth', 'B=; Max-Age=0'));
  assert.equal(jar.header(), 'A=3');
  jar.store(response('A=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT'));
  assert.equal(jar.header(), '');
});

test('parseLoginForm reads the Keycloak action and decodes &amp;', () => {
  const html =
    '<form id="kc-form-login" onsubmit="x" action="https://d-reserve.jp/auth/realms/M1/login-actions/authenticate?session_code=abc&amp;execution=e1&amp;client_id=directin-s4" method="post">';
  assert.equal(
    parseLoginForm(html),
    'https://d-reserve.jp/auth/realms/M1/login-actions/authenticate?session_code=abc&execution=e1&client_id=directin-s4',
  );
  assert.equal(parseLoginForm('<html>no form</html>'), null);
});

test('readPageGlobal parses one-line JSON statements, escaped slashes included', () => {
  const html = page();
  assert.equal(readPageGlobal(html, 'contextPath'), '/guest-reserve-front');
  assert.equal(readPageGlobal(html, 'csrfToken'), 'csrf-1');
  assert.equal(readPageGlobal(html, 'authenticatedMember'), null);
  assert.equal(readPageGlobal(html, 'missing'), undefined);
});

test('parseBookingPage returns token, candidate and member', () => {
  const parsed = parseBookingPage(page({ member: MEMBER }));
  assert.equal(parsed.csrfToken, 'csrf-1');
  assert.equal(parsed.candidateSet.hotelCode, '0000001834');
  assert.equal(parsed.member.id, 'member-1');
});

test('parseBookingPage surfaces the site conflict when there is no candidate', () => {
  assert.throws(
    () => parseBookingPage(page({ set: null, conflict: { code: 'SoldOut' } })),
    /refused the candidate: .*SoldOut/,
  );
});

test('buildEntryPayload shapes the body the way the site does', () => {
  const payload = buildEntryPayload(parseBookingPage(page({ member: MEMBER })), OPTIONS);
  const group = payload.reservationGroup;
  const reservation = group.reservations[0];
  const room = reservation.roomTypes[0].rooms[0];

  assert.equal(payload.termsAndConditionsCode, 'ARG1');
  assert.equal(payload.privacyPolicyLastUpdated, '2024-06-02T11:59:50.977+09:00');
  assert.equal(payload.referer, OPTIONS.refererUrl);
  assert.match(
    payload.paymentParameters.reserveConfirmationUrl,
    /sso\/login\?hotelCode=0000001834/,
  );

  assert.equal(group.reserver.reserverCode, 'member-1');
  assert.equal(group.reserver.livingAbroad, true);
  assert.deepEqual(group.payment, {
    method: candidateSet().paymentMethods[0],
    usePoints: 0,
    amount: 66000,
  });

  assert.equal(reservation.checkInTime, '15:00');
  assert.equal(reservation.checkInDateTime, '2026-10-29T15:00:00+09:00');
  assert.equal(reservation.paymentType, 'CREDIT_CARD');
  assert.equal(reservation.memberReserver, true);
  assert.equal(reservation.planDetails, null);
  assert.equal(reservation.cancellationPolicyDetails, null);
  assert.equal('acquirableCoupons' in reservation, false);
  assert.equal(reservation.roomTypes[0].roomTypeDetails, null);

  assert.equal(room.lodgerRepresentative, group.reserver);
  assert.deepEqual(room.lodgerTypeGenderBreakdowns, [
    {
      lodgerType: 'ADULT',
      numberOfLodgers: 2,
      numberOfMales: 1,
      numberOfFemales: 1,
      numberOfOthers: 0,
    },
  ]);
  assert.equal(room.roomChargesPerDay[0].lodgerTypeBreakdowns.length, 1);

  assert.deepEqual(reservation.questionForms[0].answerItemValues, ['0']);
  assert.equal(reservation.questionForms[0].title, null);
  assert.equal(reservation.questionForms[0].items[0].label, null);
  assert.equal(reservation.questionForms[1].answerText, null);
});

test('buildEntryPayload leaves the parsed candidate untouched', () => {
  const parsed = parseBookingPage(page({ member: MEMBER }));
  buildEntryPayload(parsed, OPTIONS);
  assert.equal(parsed.candidateSet.reservations[0].planDetails.defaultCheckInTime, '15:00');
});

test('buildEntryPayload refuses without a signed-in member or a JTB card method', () => {
  assert.throws(() => buildEntryPayload(parseBookingPage(page()), OPTIONS), /not signed in/);

  const set = candidateSet();
  set.paymentMethods[0].agent = 'ZEUS';
  assert.throws(
    () => buildEntryPayload(parseBookingPage(page({ member: MEMBER, set })), OPTIONS),
    /ZEUS, not JTB/,
  );
});

test('answerQuestions names the choices of a required question left blank', () => {
  const forms = candidateSet().reservations[0].questionForms;
  assert.throws(() => answerQuestions(forms, {}), /8153「交通手段」.*0=公共交通機関, 1=自家用車/);
  const filled = answerQuestions(forms, { 8153: '1', 8154: '東京' });
  assert.deepEqual(filled[0].answerItemValues, ['1']);
  assert.equal(filled[1].answerText, '東京');
});
