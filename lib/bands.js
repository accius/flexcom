'use strict';

/**
 * HF/6m amateur band plan helpers, used for the per-band tune memory and
 * the dashboard band buttons. Edges are the widest common allocations
 * (IARU R1/R2 superset) so bandOf() classifies any legal frequency.
 */
const BANDS = [
  { name: '160m', lowHz: 1800000, highHz: 2000000, defaultHz: 1840000 },
  { name: '80m', lowHz: 3500000, highHz: 4000000, defaultHz: 3750000 },
  { name: '60m', lowHz: 5250000, highHz: 5450000, defaultHz: 5357000 },
  { name: '40m', lowHz: 7000000, highHz: 7300000, defaultHz: 7150000 },
  { name: '30m', lowHz: 10100000, highHz: 10150000, defaultHz: 10125000 },
  { name: '20m', lowHz: 14000000, highHz: 14350000, defaultHz: 14225000 },
  { name: '17m', lowHz: 18068000, highHz: 18168000, defaultHz: 18120000 },
  { name: '15m', lowHz: 21000000, highHz: 21450000, defaultHz: 21300000 },
  { name: '12m', lowHz: 24890000, highHz: 24990000, defaultHz: 24940000 },
  { name: '10m', lowHz: 28000000, highHz: 29700000, defaultHz: 28400000 },
  { name: '6m', lowHz: 50000000, highHz: 54000000, defaultHz: 50125000 },
];

function bandOf(hz) {
  if (!hz) return null;
  const b = BANDS.find((x) => hz >= x.lowHz && hz <= x.highHz);
  return b ? b.name : null;
}

module.exports = { BANDS, bandOf };
