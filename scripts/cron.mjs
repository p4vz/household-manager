// Railway cron service entry point. Schedule it hourly ("0 * * * *") with
//   start command: node scripts/cron.mjs simplefin-sync
// It needs APP_URL and CRON_SECRET; the app decides whether this hour is a
// sync slot, so SimpleFIN is contacted only at 7 AM and 7 PM.
const job = process.argv[2];
if (!/^[a-z0-9-]+$/.test(job ?? "")) {
  console.error("usage: node scripts/cron.mjs <job>");
  process.exit(2);
}
const { APP_URL, CRON_SECRET } = process.env;
if (!APP_URL || !CRON_SECRET) {
  console.error("APP_URL and CRON_SECRET are required");
  process.exit(2);
}
const res = await fetch(new URL(`/api/cron/${job}`, APP_URL), {
  method: "POST",
  headers: { authorization: `Bearer ${CRON_SECRET}` },
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
