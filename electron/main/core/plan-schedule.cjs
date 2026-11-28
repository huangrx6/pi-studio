const DAY = 86_400_000;
const MINUTE = 60_000;

function dayStamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请选择有效日期');
  const stamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) throw new Error('请选择有效日期');
  return stamp;
}

function formatter(zone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Use a UTC calendar for arithmetic on wall-clock fields. Only the formatter translates instants.
function wallStamp(clock, instant) {
  const parts = Object.fromEntries(clock.formatToParts(instant).map(({ type, value }) => [type, value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

function instantForWall(clock, wall) {
  // Both offsets are needed around a clock change. Skip nonexistent times and fire
  // only at the first occurrence of a repeated wall time.
  const candidates = [wall - DAY, wall + DAY].map(sample => wall - (wallStamp(clock, sample) - sample));
  return candidates.sort((a, b) => a - b).find(instant => wallStamp(clock, instant) === wall) ?? null;
}

function normalizeSchedule(input) {
  if (!input || !['once', 'interval', 'daily', 'weekly', 'monthly'].includes(input.kind)) throw new Error('请选择执行频率');
  if (typeof input.zone !== 'string' || !input.zone || input.zone.length > 100) throw new Error('请选择有效时区');
  try { formatter(input.zone); } catch { throw new Error('计划时区无效'); }
  const rule = { kind: input.kind, zone: input.zone };
  if (input.kind !== 'once' && input.endDate) {
    dayStamp(input.endDate);
    rule.endDate = input.endDate;
  }
  if (input.kind === 'interval') {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 10080) throw new Error('执行间隔须为 1 至 10080 分钟');
    return { ...rule, minutes: input.minutes };
  }
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('请选择有效时间');
  rule.time = input.time;
  if (rule.kind === 'once') {
    dayStamp(input.date);
    rule.date = input.date;
  } else if (rule.kind === 'weekly') {
    if (!Array.isArray(input.days) || !input.days.length || input.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error('请至少选择一个执行日');
    }
    rule.days = [...new Set(input.days)].sort((a, b) => a - b);
  } else if (rule.kind === 'monthly') {
    if (input.day !== 'last' && (!Number.isInteger(input.day) || input.day < 1 || input.day > 31)) {
      throw new Error('请选择每月的执行日期');
    }
    rule.day = input.day;
  }
  return rule;
}

// Forwards: strictly after now. Backwards: most recent occurrence at or before now.
// Start at the current calendar slot, regardless of how many years were missed.
function occurrence(rule, now, { previous = false, anchor = now } = {}) {
  const clock = formatter(rule.zone);
  const lastDay = rule.endDate ? dayStamp(rule.endDate) : Infinity;
  if (rule.kind === 'interval') {
    const step = rule.minutes * MINUTE;
    const steps = Math.floor((now - anchor) / step) + (previous ? 0 : 1);
    const candidate = anchor + steps * step;
    return wallStamp(clock, candidate) < lastDay + DAY ? candidate : null;
  }
  const [hour, minute] = rule.time.split(':').map(Number);
  const time = (hour * 60 + minute) * MINUTE;
  if (rule.kind === 'once') {
    const at = instantForWall(clock, dayStamp(rule.date) + time);
    return at !== null && (previous ? at <= now : at > now) ? at : null;
  }
  let day = Math.floor(wallStamp(clock, now) / DAY) * DAY;
  if (previous) day = Math.min(day, lastDay);
  if (rule.kind === 'monthly') {
    const current = new Date(day);
    const year = current.getUTCFullYear(), month = current.getUTCMonth();
    // Check adjacent months directly. A short month or a DST gap can skip a slot.
    for (let i = 0; i < 6; i++) {
      const target = month + (previous ? -i : i);
      const end = new Date(Date.UTC(year, target + 1, 0)).getUTCDate();
      const date = rule.day === 'last' ? end : rule.day;
      if (date > end) continue;
      const candidateDay = Date.UTC(year, target, date);
      if (candidateDay > lastDay) {
        if (previous) continue;
        return null;
      }
      const at = instantForWall(clock, candidateDay + time);
      if (at !== null && (previous ? at <= now : at > now)) return at;
    }
    return null;
  }
  for (let offset = 0; offset < 15 && day <= lastDay; offset++, day += previous ? -DAY : DAY) {
    if (rule.kind === 'weekly' && !rule.days.includes(new Date(day).getUTCDay())) continue;
    const at = instantForWall(clock, day + time);
    if (at !== null && (previous ? at <= now : at > now)) return at;
  }
  return null;
}

function pastEndDate(rule, now) {
  return Boolean(rule.endDate && wallStamp(formatter(rule.zone), now) >= dayStamp(rule.endDate) + DAY);
}

module.exports = { normalizeSchedule, occurrence, pastEndDate };
