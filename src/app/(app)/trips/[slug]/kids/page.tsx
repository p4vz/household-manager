import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { aiConfigured, getTrip, kidsForTrip, listTravelers } from "@/modules/trips/api";
import { ErrorBanner, Field, inputCls } from "@/modules/trips/ui/form";
import { generateHuntAction, generateQuizAction, recordQuizAttemptAction, toggleHuntTaskAction } from "../../actions";

export default async function KidsPage({ params, searchParams }: PageProps<"/trips/[slug]/kids">) {
  const { slug } = await params;
  const sp = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/kids`;
  const [{ quizzes, hunts }, travelers] = await Promise.all([kidsForTrip(trip.id), listTravelers()]);
  const kids = travelers.filter((t) => t.kind === "child");
  const players = kids.length ? kids : travelers;
  const name = new Map(travelers.map((t) => [t.id, t.name]));
  const ai = aiConfigured();

  // Hunt points per traveller across the trip.
  const points = new Map<string, number>();
  for (const h of hunts) for (const t of h.tasks) for (const who of t.doneBy) points.set(who, (points.get(who) ?? 0) + t.points);

  return (
    <div className="space-y-6">
      <ErrorBanner error={sp.error} />
      {sp.scored ? (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">Scored {sp.score} of {sp.total} points.</p>
      ) : null}

      {players.length === 0 ? <p className="text-sm text-muted-foreground">Add the kids under Travellers so they can play.</p> : null}

      {points.size ? (
        <Card>
          <CardHeader><CardTitle>Scavenger hunt scores</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-4 text-sm">
            {[...points.entries()].sort((a, b) => b[1] - a[1]).map(([id, p]) => <span key={id}><strong>{name.get(id)}</strong> {p} pts</span>)}
          </CardContent>
        </Card>
      ) : null}

      {ai ? (
        <Card>
          <CardHeader><CardTitle>Make a game</CardTitle><CardDescription>Quizzes are built from the trivia gathered for the place.</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-6">
            {[
              { action: generateQuizAction, label: "New quiz" },
              { action: generateHuntAction, label: "New scavenger hunt" },
            ].map(({ action, label }) => (
              <form key={label} action={action} className="flex items-end gap-2">
                <input type="hidden" name="back" value={back} />
                <Field label="Place">
                  <select name="destinationId" className={inputCls}>{trip.destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                </Field>
                <Field label="Age"><input name="minAge" type="number" min="4" max="16" defaultValue={8} className={`${inputCls} w-16`} /></Field>
                <Button size="sm" variant="outline">{label}</Button>
              </form>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {quizzes.map((q) => (
        <Card key={q.id}>
          <CardHeader>
            <CardTitle>{q.title}</CardTitle>
            <CardDescription>
              Ages {q.minAge}+
              {q.attempts.length ? ` · recent: ${q.attempts.map((a) => `${name.get(a.travelerId)} ${a.score}/${a.totalPoints}`).slice(0, 3).join(", ")}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={recordQuizAttemptAction} className="space-y-4">
              <input type="hidden" name="quizId" value={q.id} />
              <input type="hidden" name="back" value={back} />
              {q.questions.map((x, n) => (
                <fieldset key={x.id} className="space-y-1 text-sm">
                  <legend className="font-medium">{n + 1}. {x.prompt}</legend>
                  {x.choices.map((c, i) => (
                    <label key={i} className="flex items-center gap-2"><input type="radio" name={`q_${x.id}`} value={i} required /> {c}</label>
                  ))}
                </fieldset>
              ))}
              <div className="flex items-end gap-2">
                <Field label="Who is playing">
                  <select name="travelerId" className={inputCls}>{players.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                </Field>
                <Button size="sm">Check answers</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ))}

      {hunts.map((h) => (
        <Card key={h.id}>
          <CardHeader><CardTitle>{h.title}</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {h.tasks.map((t) => (
                <li key={t.id} className="space-y-1">
                  <div><strong>{t.prompt}</strong> <span className="text-muted-foreground">{t.points} pts{t.hint ? ` · hint: ${t.hint}` : ""}</span></div>
                  <div className="flex flex-wrap gap-2">
                    {players.map((p) => (
                      <form key={p.id} action={toggleHuntTaskAction}>
                        <input type="hidden" name="taskId" value={t.id} />
                        <input type="hidden" name="travelerId" value={p.id} />
                        <input type="hidden" name="back" value={back} />
                        <button className={`rounded-full border px-2 py-0.5 text-xs ${t.doneBy.includes(p.id) ? "bg-primary text-primary-foreground" : ""}`}>
                          {t.doneBy.includes(p.id) ? "✓ " : ""}{p.name}
                        </button>
                      </form>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
