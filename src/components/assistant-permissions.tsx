import { PERMISSION_SECTIONS, THE_RULE, type PermissionItem } from "@/core/oauth/permissions";

/** One checkbox per permission, grouped by app section. Field name: `perm`. */
export function PermissionCheckboxes({ selected, idPrefix }: { selected: readonly string[]; idPrefix: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {PERMISSION_SECTIONS.map((section) => (
        <fieldset key={section.id} className="space-y-1">
          <legend className="text-sm font-medium">{section.title}</legend>
          {(section.items as readonly PermissionItem[]).map((item) => {
            const id = `${idPrefix}-${item.key}`;
            const off = item.available === false;
            return (
              <label key={item.key} htmlFor={id} className={`flex items-start gap-2 text-sm ${off ? "opacity-50" : ""}`}>
                <input
                  id={id}
                  type="checkbox"
                  name="perm"
                  value={item.key}
                  defaultChecked={!off && selected.includes(item.key)}
                  disabled={off}
                  className="mt-0.5"
                />
                <span>
                  {item.label}
                  {item.note ? <span className="opacity-70"> ({item.note})</span> : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

/** The non-negotiable rule, shown wherever access is granted or changed. */
export function AssistantRule() {
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
      <p className="font-semibold">Always enforced, whatever is ticked:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {THE_RULE.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
