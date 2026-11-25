import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy" };

/**
 * Public privacy policy. Google requires a link to one before the OAuth app
 * can be set to "In production" (otherwise calendar refresh tokens expire
 * after 7 days). Static text only: it reads no session and no household data.
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 space-y-4 p-6 text-sm leading-6">
      <h1 className="text-xl font-semibold">Privacy policy</h1>
      <p>
        Aprelev Household is a private app run by one household for its own members. It is not offered to the public, and only
        Google accounts the household has invited can sign in.
      </p>
      <h2 className="pt-2 font-semibold">What the app uses</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Google sign-in: your Google account&apos;s email address and name, only to check that you are an invited member.</li>
        <li>
          Google Calendar: events on calendars the household chose to connect, so they can be shown and edited in the
          app and on the household&apos;s kitchen screen.
        </li>
        <li>Data the household enters or imports itself, such as finances, chores, home upkeep and trips.</li>
      </ul>
      <h2 className="pt-2 font-semibold">How it is handled</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>Data is stored in the household&apos;s own database and is not sold, shared for advertising, or given to anyone else.</li>
        <li>
          Google user data is used only to provide the features above. Its use follows the Google API Services User
          Data Policy, including the Limited Use requirements.
        </li>
        <li>
          When the household asks the app&apos;s AI assistant for help, it sends only the details needed for that request,
          with account numbers and other identifiers removed.
        </li>
      </ul>
      <h2 className="pt-2 font-semibold">Removing access</h2>
      <p>
        You can remove the app&apos;s access to your Google account at any time at{" "}
        <a className="underline" href="https://myaccount.google.com/permissions">
          myaccount.google.com/permissions
        </a>
        . Members can ask the household to delete their data from the app.
      </p>
    </main>
  );
}
