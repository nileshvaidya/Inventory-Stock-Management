// Generic CSV export (build brief: "Excel/CSV export on every major
// table") — pure row-building/serialization here, reusable by every
// table-heavy screen from Phase 2 on, with a small DOM-touching trigger
// function kept separate so the serialization itself stays unit-testable.

/**
 * @param {Record<string, unknown>[]} rows objects keyed by column header
 * @param {{ key: string, header: string }[]} columns column order + labels
 * @returns {string} CSV text, CRLF line endings, values quoted only when needed
 */
export function toCsv(rows, columns) {
  const escapeCell = (value) => {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const headerLine = columns.map((c) => escapeCell(c.header)).join(',');
  const bodyLines = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(','));
  return [headerLine, ...bodyLines].join('\r\n');
}

/**
 * @param {string} csvText
 * @param {string} filename
 */
export function downloadCsv(csvText, filename) {
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
