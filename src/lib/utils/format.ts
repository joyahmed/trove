const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Explorer-style: KB with no decimals below 1 MB, one decimal above. */
export const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 1 ? Math.ceil(v) : v.toFixed(1)} ${UNITS[u]}`;
};

/** Explorer's drive capacity text: three significant digits — "45.3 GB", "237 GB", "1.81 TB". */
export const fmtSpace = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[u]}`;
};

const two = (n: number) => String(n).padStart(2, '0');

/** Explorer's Date modified: `dd/MM/yyyy HH:mm`, local time, no comma. */
export const fmtDate = (ms: number | null): string => {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
