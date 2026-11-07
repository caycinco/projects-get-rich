export function toUtcIso(value) {
  if (value == null || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  return date.toISOString();
}

export function unixSecondsToUtc(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  return new Date(Number(seconds) * 1000).toISOString();
}

export function formatLondon(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}`;
}

export function formatRawAmount(raw, decimals) {
  if (raw == null || decimals == null) return null;
  const text = String(raw);
  if (!/^-?\d+$/.test(text)) return null;
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 18) return null;
  const padded = digits.padStart(places + 1, "0");
  const whole = padded.slice(0, padded.length - places);
  const fraction = places ? padded.slice(padded.length - places).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
