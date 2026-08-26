import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GlobalpingError, measure, median, toRows,
} from "../src/globalping.js";

/** A payload shaped exactly like a real Globalping http response. */
const FINISHED = {
  id: "abc",
  status: "finished",
  target: "example.com",
  type: "http",
  results: [
    {
      probe: {
        country: "DE", city: "Falkenstein", network: "Hetzner Online",
        asn: 24940, continent: "EU",
      },
      result: {
        status: "finished", statusCode: 200, resolvedAddress: "93.184.-.-",
        timings: { total: 40, dns: 2, tcp: 5, tls: 21, firstByte: 12, download: 0 },
      },
    },
    {
      probe: { country: "IR", city: "Tehran", network: "Some ISP", asn: 1, continent: "AS" },
      result: { status: "failed", rawOutput: "connect ETIMEDOUT\nmore detail" },
    },
  ],
};

function stubFetch(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match));
    if (!route) throw new Error(`no stub for ${url}`);
    const body = typeof route.body === "function" ? route.body() : route.body;
    return {
      ok: route.status === undefined || route.status < 400,
      status: route.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetch, calls };
}

test("posts the countries and polls until finished", async () => {
  let polls = 0;
  const { fetch, calls } = stubFetch([
    { match: "/measurements/", body: () => {
      polls++;
      return polls < 3 ? { status: "in-progress" } : FINISHED;
    } },
    { match: "/measurements", body: { id: "abc", probesCount: 2 } },
  ]);

  const payload = await measure(
    { target: "example.com", countries: ["de", "ir"], limit: 2 },
    { fetch, sleep: async () => {} });

  assert.equal(payload.status, "finished");
  assert.equal(polls, 3, "should poll until the measurement is done");

  const posted = JSON.parse(calls[0].init.body);
  assert.deepEqual(posted.locations,
    [{ country: "DE", limit: 2 }, { country: "IR", limit: 2 }]);
  assert.equal(posted.type, "http");
  assert.equal(posted.measurementOptions.request.path, "/");
});

test("sends the requested path for http measurements", async () => {
  const { fetch, calls } = stubFetch([
    { match: "/measurements/", body: FINISHED },
    { match: "/measurements", body: { id: "abc", probesCount: 1 } },
  ]);
  await measure({ target: "x.dev", countries: ["de"], path: "/pricing" },
    { fetch, sleep: async () => {} });
  const posted = JSON.parse(calls[0].init.body);
  assert.equal(posted.measurementOptions.request.path, "/pricing");
});

test("omits http options for a ping measurement", async () => {
  const { fetch, calls } = stubFetch([
    { match: "/measurements/", body: FINISHED },
    { match: "/measurements", body: { id: "abc", probesCount: 1 } },
  ]);
  await measure({ target: "x.dev", countries: ["de"], type: "ping" },
    { fetch, sleep: async () => {} });
  const posted = JSON.parse(calls[0].init.body);
  assert.equal(posted.measurementOptions, undefined);
});

test("explains a rate limit instead of leaking a status code", async () => {
  const { fetch } = stubFetch([
    { match: "/measurements", body: {}, status: 429 },
  ]);
  await assert.rejects(
    () => measure({ target: "x.dev", countries: ["de"] }, { fetch }),
    (error) => {
      assert.ok(error instanceof GlobalpingError);
      assert.equal(error.status, 429);
      assert.match(error.message, /rate limited/);
      return true;
    });
});

test("says so when no probe matches the countries", async () => {
  const { fetch } = stubFetch([
    { match: "/measurements", body: { id: "abc", probesCount: 0 } },
  ]);
  await assert.rejects(
    () => measure({ target: "x.dev", countries: ["zz"] }, { fetch }),
    /no probes matched/);
});

test("flattens a payload into one row per probe", () => {
  const rows = toRows(FINISHED);
  assert.equal(rows.length, 2);

  const [de, ir] = rows;
  assert.equal(de.country, "DE");
  assert.equal(de.ttfb, 12);
  assert.equal(de.total, 40);
  assert.equal(de.failed, false);

  assert.equal(ir.failed, true, "a failed probe must be marked failed");
  assert.equal(ir.ttfb, null, "a failed probe has no timings");
  assert.equal(ir.error, "connect ETIMEDOUT", "only the first line of output");
});

test("treats a missing status code as a failure", () => {
  const rows = toRows({ results: [{ probe: { country: "US" }, result: {} }] });
  assert.equal(rows[0].failed, true);
  assert.equal(rows[0].error, "no response");
});

test("survives an empty payload", () => {
  assert.deepEqual(toRows({}), []);
});

test("median ignores nulls and handles both parities", () => {
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([null, 10, null]), 10);
  assert.equal(median([]), null);
  assert.equal(median([null, null]), null);
});
