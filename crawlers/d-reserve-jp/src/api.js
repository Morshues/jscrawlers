import { fetchJson, HttpError, throttle } from '@jscrawlers/core';

/**
 * Client for the d-reserve.jp room calendar.
 *
 *   GET {apiBase}/v1/search/hotels/{hotelCode}/calendar?fromYM=..&toYM=..
 *
 * No auth and no cookies are needed. The response nests days inside room types;
 * we flatten it into a flat `roomCode|salesDate` map so diffing is a plain
 * key-by-key comparison.
 */

/** Stable identity of one (room type, check-in date) pair. */
export function cellKey(roomCode, salesDate) {
  return `${roomCode}|${salesDate}`;
}

export function buildCalendarUrl({ apiBase, hotelCode, query }, { fromYM, toYM }) {
  const url = new URL(`/v1/search/hotels/${hotelCode}/calendar`, apiBase);
  url.searchParams.set('fromYM', fromYM);
  url.searchParams.set('toYM', toYM);
  url.searchParams.set('lodgerCode', query.lodgerCode);
  url.searchParams.set('lodgerNum', query.lodgerNum);
  url.searchParams.set('stays', query.stays);
  url.searchParams.set('onlyAllLanguagesPlan', String(query.onlyAllLanguagesPlan));
  url.searchParams.set('onlyAllRankPlan', String(query.onlyAllRankPlan));
  return url.href;
}

/**
 * The API answers a bad request with a validation document rather than a plain
 * status. Surfacing its `errors[].code` turns "HTTP 400" into something you can
 * act on, e.g. AvailableYearMonthPeriodOutOfRange when a window spans >2 months.
 */
async function describeHttpError(error) {
  if (!(error instanceof HttpError)) return error;
  try {
    const body = await error.response.json();
    const codes = (body.errors ?? [])
      .map((entry) => entry.code?.split('.').pop())
      .filter(Boolean)
      .join(', ');
    if (codes) return new Error(`${error.message} — ${body.message ?? 'error'}: ${codes}`);
  } catch {
    // Not the validation shape; the original error is the best we have.
  }
  return error;
}

/** salesAvailable is the authoritative flag; stockStatus is recorded, never trusted. */
const KNOWN_STOCK_STATUS = new Set(['SOLD_OUT', 'NO_SALE', 'FEW_STOCK']);

/**
 * Flatten one API response into rooms + cells, dropping days outside the
 * configured range (the API always returns whole months).
 */
export function normalize(data, { fromDate, toDate, logger } = {}) {
  const rooms = {};
  const cells = {};

  for (const room of data ?? []) {
    rooms[room.code] = {
      code: room.code,
      name: room.name,
      minRoomCapacity: room.minRoomCapacity,
      maxRoomCapacity: room.maxRoomCapacity,
      tags: (room.searchTagList ?? []).map((tag) => tag.name),
      imageUrl: room.imageList?.[0]?.url ?? null,
    };

    for (const day of room.dailySalesStatusList ?? []) {
      if (fromDate && day.salesDate < fromDate) continue;
      if (toDate && day.salesDate > toDate) continue;

      if (day.stockStatus && !KNOWN_STOCK_STATUS.has(day.stockStatus)) {
        logger?.warn(
          `unseen stockStatus "${day.stockStatus}" on ${room.code} ${day.salesDate}; ` +
            'still using salesAvailable to decide bookability',
        );
      }

      cells[cellKey(room.code, day.salesDate)] = {
        roomCode: room.code,
        roomName: room.name,
        salesDate: day.salesDate,
        dayOfWeek: day.dayOfWeek,
        available: day.salesAvailable === true,
        stockStatus: day.stockStatus ?? null,
        stockNum: day.stockNum ?? 0,
        noSaleReason: day.noSaleReason ?? null,
        // Past dates come back with a null plan, so never dereference blindly.
        memberPrice: day.lowestPlanForMember?.totalPrice ?? null,
        regularPrice: day.lowestPlanForRegular?.totalPrice ?? null,
        planCode: day.lowestPlanForMember?.planCode ?? day.lowestPlanForRegular?.planCode ?? null,
      };
    }
  }

  return { rooms, cells };
}

/**
 * Fetch every window and merge the results into one snapshot.
 *
 * @returns {Promise<{ rooms: object, cells: object, raw: unknown[], fetchedAt: string }>}
 */
export async function fetchSnapshot(config, { logger, signal } = {}) {
  const wait = throttle(config.poll.requestDelayMs);
  const rooms = {};
  const cells = {};
  const raw = [];

  for (const window of config.windows) {
    if (signal?.aborted) break;
    await wait();

    const url = buildCalendarUrl(config, window);
    logger?.debug(`window ${window.fromYM}..${window.toYM}`);

    let body;
    try {
      body = await fetchJson(url, { logger, signal });
    } catch (error) {
      throw await describeHttpError(error);
    }

    raw.push({ window, data: body.data });
    const part = normalize(body.data, { ...config, logger });
    Object.assign(rooms, part.rooms);
    Object.assign(cells, part.cells);
  }

  return { rooms, cells, raw, fetchedAt: new Date().toISOString() };
}
