// Railway cron service entry point. Schedule it hourly ("0 * * * *") with
//   start command: node scripts/cron.mjs simplefin-sync monthly-advisor
// It needs APP_URL and CRON_SECRET. The app decides whether each job is due
// this hour: SimpleFIN only at 7 AM / 7 PM, the advisor on the 1st at 8 AM.
const jobs = process.argv.slice(2);
if (jobs.length === 0 || !jobs.every((j) => /^[a-z0-9-]+$/.test(j))) {
  console.error("usage: node scripts/cron.mjs <job> [job...]");
  process.exit(2);
}
const { APP_URL, CRON_SECRET } = process.env;
if (!APP_URL || !CRON_SECRET) {
  console.error("APP_URL and CRON_SECRET are required");
  process.exit(2);
}
let failed = false;
for (const job of jobs) {
  const res = await fetch(new URL(`/api/cron/${job}`, APP_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  console.log(job, res.status, await res.text());
  failed ||= !res.ok;
}
process.exit(failed ? 1 : 0);
