/**
 * Minimal client for the Globalping API.
 *
 * Globalping runs a network of volunteer probes and exposes them without an
 * API key. That is what makes this tool possible: measuring from your own
 * machine tells you about your own machine, not about your users.
 *
 * @see https://globalping.io
 */

const API = "https://api.globalping.io/v1";

/** How long to keep asking for a result before giving up. */
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 900;

export class GlobalpingError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = "GlobalpingError";
    this.status = status;
  }
}

/**
 * @typedef {object} Deps
 * @property {typeof fetch} [fetch]
 * @property {(ms: number) => Promise<void>} [sleep]
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a measurement and wait for it to finish.
 *
 * @param {object} request
 * @param {string} request.target
 * @param {string} [request.type]
 * @param {string[]} request.countries
 * @param {number} [request.limit] probes per country
 * @param {string} [request.path] request path, for http measurements
 * @param {Deps} [deps]
 */
export async function measure(request, deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const type = request.type ?? "http";

  const body = {
    type,
    target: request.target,
    locations: request.countries.map((country) => ({
      country: country.toUpperCase(),
      limit: request.limit ?? 1,
    })),
  };
  if (type === "http") {
    body.measurementOptions = {
      request: { method: "GET", path: request.path ?? "/" },
    };
  }

  const created = await doFetch(`${API}/measurements`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (created.status === 429) {
    throw new GlobalpingError(
      "rate limited by Globalping, try again in a few minutes", 429);
  }
  if (!created.ok) {
    const detail = await safeText(created);
    throw new GlobalpingError(
      `could not start measurement (HTTP ${created.status}) ${detail}`.trim(),
      created.status);
  }

  const { id, probesCount } = await created.json();
  if (!probesCount) {
    throw new GlobalpingError(
      "no probes matched those countries, try fewer or different ones");
  }

  const started = Date.now();
  for (;;) {
    const res = await doFetch(`${API}/measurements/${id}`);
    if (!res.ok) {
      throw new GlobalpingError(
        `could not read measurement (HTTP ${res.status})`, res.status);
    }
    const payload = await res.json();
    if (payload.status !== "in-progress") return payload;
    if (Date.now() - started > POLL_TIMEOUT_MS) {
      throw new GlobalpingError("measurement did not finish in time");
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Flatten an API payload into one row per probe.
 *
 * Probes fail for ordinary reasons (a blocked port, a probe going offline
 * mid-measurement), so a row carries either timings or an error, never both.
 */
export function toRows(payload) {
  return (payload.results ?? []).map((entry) => {
    const probe = entry.probe ?? {};
    const result = entry.result ?? {};
    const timings = result.timings ?? {};
    const failed = result.status === "failed" || result.statusCode == null;

    return {
      country: probe.country ?? "??",
      city: probe.city ?? "",
      network: probe.network ?? "",
      asn: probe.asn ?? null,
      continent: probe.continent ?? "",
      address: result.resolvedAddress ?? null,
      statusCode: result.statusCode ?? null,
      dns: numberOrNull(timings.dns),
      tcp: numberOrNull(timings.tcp),
      tls: numberOrNull(timings.tls),
      ttfb: numberOrNull(timings.firstByte),
      total: numberOrNull(timings.total),
      failed,
      error: failed ? firstLine(result.rawOutput) : null,
    };
  });
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function firstLine(text) {
  if (typeof text !== "string" || text.trim() === "") return "no response";
  return text.trim().split("\n")[0].slice(0, 80);
}

/** Median of the finite numbers in a list, or null when there are none. */
export function median(values) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
