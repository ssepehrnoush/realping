#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { GlobalpingError, measure, median, toRows } from "./globalping.js";
import { bold, dim, renderSummary, renderTable } from "./render.js";

/**
 * Default spread. Iran is in the list on purpose: it is the case that a
 * laptop measurement gets most wrong, and no other latency tool defaults to
 * including it.
 */
const DEFAULT_COUNTRIES = ["IR", "TR", "DE", "NL", "GB", "US", "AE", "IN"];

const SORTS = ["ttfb", "total", "dns", "country"];

const HELP = `realping - measure your site the way your users see it

Measuring from your own machine measures your own machine: your proxy, your
DNS, your nearest CDN edge. realping runs the request from real probes in
other countries instead.

Usage
  realping <target> [options]

Options
  --from <cc,cc>     country codes to measure from
                     (default: ${DEFAULT_COUNTRIES.join(",")})
  --limit <n>        probes per country (default: 1)
  --type <t>         http (default), ping, dns, traceroute
  --path <p>         request path for http (default: /)
  --sort <field>     ${SORTS.join(", ")} (default: ttfb)
  --json             print raw JSON instead of a table
  -h, --help         this message

Examples
  realping example.com
  realping example.com --from ir,tr,de --limit 2
  realping example.com --path /pricing --sort total
  realping example.com --json > before.json
`;

function parseArgs(argv) {
  const options = {
    target: null,
    countries: DEFAULT_COUNTRIES,
    limit: 1,
    type: "http",
    path: "/",
    sort: "ttfb",
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return "help";
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--from") {
      options.countries = (argv[++i] ?? "")
        .split(",").map((c) => c.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--limit") { options.limit = Number(argv[++i]); continue; }
    if (arg === "--type") { options.type = argv[++i]; continue; }
    if (arg === "--path") { options.path = argv[++i]; continue; }
    if (arg === "--sort") { options.sort = argv[++i]; continue; }
    if (arg.startsWith("-")) {
      process.stderr.write(`unknown option: ${arg}\n`);
      return null;
    }
    if (options.target === null) options.target = arg;
  }

  if (options.target === null) return "help";
  if (!SORTS.includes(options.sort)) {
    process.stderr.write(
      `--sort must be one of: ${SORTS.join(", ")}\n`);
    return null;
  }
  if (options.countries.length === 0) {
    process.stderr.write("--from needs at least one country code\n");
    return null;
  }
  return options;
}

function sortRows(rows, key) {
  const missingLast = (a, b) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return a - b;
  };
  return [...rows].sort((a, b) => {
    if (a.failed !== b.failed) return a.failed ? 1 : -1;
    if (key === "country") return a.country.localeCompare(b.country);
    return missingLast(a[key], b[key]);
  });
}

export async function run(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed === null) return 2;
  if (parsed === "help") {
    process.stdout.write(HELP);
    // No target at all is a usage error; an explicit --help is not.
    return argv.length === 0 ? 2 : 0;
  }

  if (!parsed.json) {
    process.stderr.write(dim(
      `measuring ${parsed.target} from ${parsed.countries.length} ` +
      `countries...\n`));
  }

  let payload;
  try {
    payload = await measure({
      target: parsed.target,
      type: parsed.type,
      countries: parsed.countries,
      limit: parsed.limit,
      path: parsed.path,
    }, deps);
  } catch (error) {
    const hint = error instanceof GlobalpingError
      ? ""
      : "\nhint: this looks like a network or DNS problem on this machine\n";
    process.stderr.write(`error: ${error.message}\n${hint}`);
    return 1;
  }

  const rows = sortRows(toRows(payload), parsed.sort);
  const medians = {
    ttfb: median(rows.map((r) => r.ttfb)),
    total: median(rows.map((r) => r.total)),
    dns: median(rows.map((r) => r.dns)),
  };

  if (parsed.json) {
    process.stdout.write(JSON.stringify(
      { target: parsed.target, type: parsed.type, medians, rows }, null, 2) + "\n");
    return rows.every((r) => r.failed) ? 1 : 0;
  }

  const asked = new Set(parsed.countries.map((c) => c.toUpperCase()));
  const answered = new Set(rows.map((r) => r.country));
  const absent = [...asked].filter((c) => !answered.has(c));

  process.stdout.write(`\n${bold(parsed.target)}\n\n`);
  process.stdout.write(renderTable(rows));
  process.stdout.write(renderSummary(rows, medians));
  if (absent.length > 0) {
    process.stdout.write(dim(
      `no probe available in: ${absent.join(", ")}\n`));
  }
  return rows.every((r) => r.failed) ? 1 : 0;
}

// Run only when invoked directly, so importing this module in a test does
// not fire a live measurement.
if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2));
}
