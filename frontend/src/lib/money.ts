// An amount of money as the page writes an estimate: two figures are all an estimate is worth.

const formats = new Map<string, Intl.NumberFormat>();

function format(locale: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}\u0000${decimals}`;
  let made = formats.get(key);
  if (!made) {
    // The sign alone, "$", as every price of the interface writes it: Intl's own symbol would be
    // "$US" in French beside the "$" of the price line.
    made = new Intl.NumberFormat(locale, {
      style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
      minimumFractionDigits: decimals, maximumFractionDigits: decimals,
    });
    formats.set(key, made);
  }
  return made;
}

/** The decimals two significant figures of a positive value need, the zeros at the end dropped. */
function decimalsOf(rounded: number): number {
  const needed = Math.max(0, 1 - Math.floor(Math.log10(rounded)));
  const written = rounded.toFixed(needed).replace(/\.?0+$/, "");
  const point = written.indexOf(".");
  return point < 0 ? 0 : written.length - point - 1;
}

/** Dollars for 100 messages, rounded to two significant figures: no cents from 10 up, and always
 *  cents below, at least two decimals and as many as the two figures need ("0,012 $"). */
export function per100(value: number, locale: string): string {
  if (!(value > 0)) return format(locale, 2).format(0);
  const rounded = Number(value.toPrecision(2));
  const decimals = rounded >= 10 ? 0 : Math.max(2, decimalsOf(rounded));
  return format(locale, decimals).format(rounded);
}
