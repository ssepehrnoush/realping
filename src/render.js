/** Terminal table rendering, with no dependencies and no colour when piped. */

const useColour = process.stdout.isTTY === true && !process.env["NO_COLOR"];
const paint = (code, s) => (useColour ? `\u001B[${code}m${s}\u001B[0m` : s);

export const dim = (s) => paint("2", s);
export const bold = (s) => paint("1", s);
export const red = (s) => paint("31", s);
export const green = (s) => paint("32", s);
export const yellow = (s) => paint("33", s);

/**
 * Colour a latency by how it will feel, not by an arbitrary scale.
 * The thresholds come from the usual interaction-latency guidance: under
 * 300ms reads as immediate, past a second the page feels broken.
 */
export function gradeMs(ms) {
  if (ms == null) return dim("-");
  const text = `${ms}`;
  if (ms < 300) return green(text);
  if (ms < 1000) return yellow(text);
  return red(text);
}

const COLUMNS = [
  { key: "country", label: "CC", align: "left" },
  { key: "city", label: "CITY", align: "left", max: 16 },
  { key: "network", label: "NETWORK", align: "left", max: 22 },
  { key: "dns", label: "DNS", align: "right", ms: true },
  { key: "tcp", label: "TCP", align: "right", ms: true },
  { key: "tls", label: "TLS", align: "right", ms: true },
  { key: "ttfb", label: "TTFB", align: "right", ms: true },
  { key: "total", label: "TOTAL", align: "right", ms: true },
];

function cellText(row, column) {
  const value = row[column.key];
  if (value == null) return "-";
  let text = `${value}`;
  if (column.max && text.length > column.max) {
    text = `${text.slice(0, column.max - 1)}…`;
  }
  return text;
}

/** Visible length, ignoring ANSI colour codes. */
function width(s) {
  return s.replace(/\u001B\[[0-9;]*m/g, "").length;
}

function pad(s, to, align) {
  const gap = Math.max(0, to - width(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

export function renderTable(rows) {
  if (rows.length === 0) return "no results\n";

  const widths = COLUMNS.map((column) =>
    Math.max(column.label.length,
      ...rows.map((row) => cellText(row, column).length)));

  const header = COLUMNS
    .map((column, i) => dim(pad(column.label, widths[i], column.align)))
    .join("  ");

  const lines = rows.map((row) => {
    if (row.failed) {
      const head = COLUMNS.slice(0, 3)
        .map((column, i) => pad(cellText(row, column), widths[i], column.align))
        .join("  ");
      return `${head}  ${red(row.error ?? "failed")}`;
    }
    return COLUMNS
      .map((column, i) => {
        const text = cellText(row, column);
        const shown = column.ms ? gradeMs(row[column.key]) : text;
        return pad(shown, widths[i], column.align);
      })
      .join("  ");
  });

  return [header, ...lines].join("\n") + "\n";
}

/**
 * A one-line verdict. The median matters more than the best result: the
 * fastest probe is usually the one nearest your CDN edge, which is exactly
 * the number that misleads you when measuring from your own laptop.
 */
export function renderSummary(rows, medians) {
  const ok = rows.filter((r) => !r.failed);
  const failed = rows.length - ok.length;
  const parts = [
    `${ok.length}/${rows.length} probes answered`,
  ];
  if (medians.ttfb != null) parts.push(`median TTFB ${gradeMs(medians.ttfb)}ms`);
  if (medians.total != null) parts.push(`median total ${medians.total}ms`);
  if (failed > 0) parts.push(red(`${failed} failed`));
  return `\n${parts.join(dim("  |  "))}\n`;
}
