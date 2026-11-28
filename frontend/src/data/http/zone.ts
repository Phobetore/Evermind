/** The device's time zone, as the server is told it with each question about spending: its name,
 *  and its offset in minutes east of UTC for a name the server does not know. Here rather than in
 *  the page's code, which the data source does not import. */
export function zoneOfDevice(): { tz: string; tzo: number } {
  let tz = "";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    /* no zone named: the offset alone says it */
  }
  // getTimezoneOffset counts west of UTC; || 0 keeps -0 out of the address.
  return { tz, tzo: -new Date().getTimezoneOffset() || 0 };
}
