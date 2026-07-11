// 最小限のICS（iCalendar）パーサ。Outlookの「予定表の公開」URLからの取得を想定。
// 対応: VEVENT / DTSTART / DTEND / SUMMARY / LOCATION / STATUS / EXDATE /
//       RRULE (FREQ=DAILY|WEEKLY|MONTHLY(BYDAYなし単純), INTERVAL, BYDAY, UNTIL, COUNT)
// タイムゾーン: Z付きはUTC→JST(+9h)、TZID付き・なしは壁時計そのまま（日本前提）。

const DAY_MS = 86400000;

function unfoldLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

function parseDt(value, params) {
  // 戻り値: { date: Date(壁時計をUTC扱いで保持), allDay: bool }
  if (/^\d{8}$/.test(value)) {
    return { date: new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  let date = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  if (m[7] === "Z") date = new Date(date.getTime() + 9 * 3600000); // UTC→JST
  return { date, allDay: false };
}

function fmt(date, allDay) {
  const iso = date.toISOString();
  return allDay ? iso.slice(0, 10) : iso.slice(0, 16);
}

function parseRrule(str) {
  const rule = {};
  for (const part of str.split(";")) {
    const [k, v] = part.split("=");
    rule[k] = v;
  }
  return rule;
}

const BYDAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };

function expandRrule(ev, rule, windowStart, windowEnd) {
  const out = [];
  const freq = rule.FREQ;
  const interval = parseInt(rule.INTERVAL || "1", 10);
  const until = rule.UNTIL ? parseDt(rule.UNTIL, {})?.date : null;
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
  const durMs = ev.endDate - ev.startDate;
  const limit = new Date(Math.min(windowEnd.getTime(), (until || windowEnd).getTime()));

  let occurrences = [];
  if (freq === "WEEKLY" && rule.BYDAY) {
    const days = rule.BYDAY.split(",").map((d) => BYDAY_MAP[d]).filter((d) => d !== undefined);
    // 基準週の開始（DTSTARTの週の日曜0時）
    const base = new Date(ev.startDate);
    const weekStart = new Date(base.getTime() - base.getUTCDay() * DAY_MS);
    for (let w = 0; ; w += interval) {
      const ws = new Date(weekStart.getTime() + w * 7 * DAY_MS);
      if (ws > limit) break;
      for (const dow of days) {
        const occ = new Date(ws.getTime() + dow * DAY_MS);
        occ.setUTCHours(ev.startDate.getUTCHours(), ev.startDate.getUTCMinutes(), 0, 0);
        if (occ < ev.startDate) continue;
        occurrences.push(occ);
      }
      if (occurrences.length > 1000) break;
    }
  } else if (freq === "DAILY" || freq === "WEEKLY" || freq === "MONTHLY") {
    let occ = new Date(ev.startDate);
    let guard = 0;
    while (occ <= limit && guard < 1000) {
      occurrences.push(new Date(occ));
      if (freq === "DAILY") occ = new Date(occ.getTime() + interval * DAY_MS);
      else if (freq === "WEEKLY") occ = new Date(occ.getTime() + interval * 7 * DAY_MS);
      else occ.setUTCMonth(occ.getUTCMonth() + interval);
      guard += 1;
    }
  } else {
    return [ev]; // 未対応FREQは初回のみ
  }

  occurrences.sort((a, b) => a - b);
  if (count) occurrences = occurrences.slice(0, count);
  for (const occ of occurrences) {
    if (occ > limit) continue;
    const end = new Date(occ.getTime() + durMs);
    if (end < windowStart) continue;
    if (ev.exdates.some((ex) => Math.abs(ex - occ) < 60000)) continue;
    out.push({ ...ev, startDate: occ, endDate: end });
  }
  return out;
}

export function parseIcs(text, owner, windowStart, windowEnd) {
  const lines = unfoldLines(text);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { exdates: [], rrule: null, allDay: false };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur && cur.startDate && cur.status !== "CANCELLED") {
        if (!cur.endDate) cur.endDate = new Date(cur.startDate.getTime() + (cur.allDay ? DAY_MS : 3600000));
        const expanded = cur.rrule
          ? expandRrule(cur, cur.rrule, windowStart, windowEnd)
          : [cur];
        for (const ev of expanded) {
          if (ev.endDate < windowStart || ev.startDate > windowEnd) continue;
          events.push({
            title: ev.summary || "(件名なし)",
            start: fmt(ev.startDate, ev.allDay),
            end: fmt(ev.endDate, ev.allDay),
            allDay: ev.allDay,
            location: ev.location || "",
            owner,
          });
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci < 0) continue;
    const left = line.slice(0, ci);
    const value = line.slice(ci + 1);
    const [prop] = left.split(";");
    if (prop === "DTSTART") {
      const dt = parseDt(value, {});
      if (dt) {
        cur.startDate = dt.date;
        cur.allDay = dt.allDay;
      }
    } else if (prop === "DTEND") {
      const dt = parseDt(value, {});
      if (dt) cur.endDate = dt.date;
    } else if (prop === "SUMMARY") {
      cur.summary = value.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " ");
    } else if (prop === "LOCATION") {
      cur.location = value.replace(/\\,/g, ",").replace(/\\;/g, ";");
    } else if (prop === "STATUS") {
      cur.status = value;
    } else if (prop === "RRULE") {
      cur.rrule = parseRrule(value);
    } else if (prop === "EXDATE") {
      for (const v of value.split(",")) {
        const dt = parseDt(v.trim(), {});
        if (dt) cur.exdates.push(dt.date);
      }
    }
  }
  return events;
}
