import { ConnectForm } from "@/modules/finance/ui/connect-form";
import { connectSimplefinAction } from "../actions";

export default function ConnectPage() {
  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Connect SimpleFIN</h1>
      <ol className="list-decimal space-y-1 pl-5 text-sm opacity-80">
        <li>In SimpleFIN Bridge, link your banks, then create a new setup token for this app.</li>
        <li>Paste it below. It can be used once; the app swaps it for a permanent key that stays encrypted on the server.</li>
        <li>The first sync pulls about 90 days. After that the app syncs at 7 AM and 7 PM.</li>
      </ol>
      <ConnectForm action={connectSimplefinAction} />
    </section>
  );
}
