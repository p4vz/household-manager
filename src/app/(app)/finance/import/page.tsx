import { CsvImporter } from "@/modules/finance/ui/csv-importer";
import { commitCsvAction, previewCsvAction } from "../actions";

export default function ImportPage() {
  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Import Simplifi history</h1>
      <p className="text-sm opacity-80">
        In Quicken Simplifi, open Transactions, choose all dates, and export to CSV. Rows already in the
        app, and rows from dates the bank sync already covers, are skipped, so it is safe to import the
        same file more than once.
      </p>
      <CsvImporter preview={previewCsvAction} commit={commitCsvAction} />
    </section>
  );
}
