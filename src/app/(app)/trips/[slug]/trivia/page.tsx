import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { aiConfigured, getTrip, triviaForTrip } from "@/modules/trips/api";
import { ErrorBanner } from "@/modules/trips/ui/form";
import { deleteTriviaFactAction, generateTriviaAction } from "../../actions";

export default async function TriviaPage({ params, searchParams }: PageProps<"/trips/[slug]/trivia">) {
  const { slug } = await params;
  const { error } = await searchParams;
  const trip = await getTrip(slug);
  if (!trip) notFound();
  const back = `/trips/${slug}/trivia`;
  const facts = await triviaForTrip(trip.id);
  const ai = await aiConfigured();

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {trip.destinations.map((d) => {
        const here = facts.filter((f) => f.destinationId === d.id).map((f) => f.fact);
        return (
          <Card key={d.id}>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{d.name}</CardTitle>
              {ai ? (
                <form action={generateTriviaAction}>
                  <input type="hidden" name="destinationId" value={d.id} />
                  <input type="hidden" name="back" value={back} />
                  <Button size="sm" variant="outline">{here.length ? "More trivia" : "Generate trivia"}</Button>
                </form>
              ) : null}
            </CardHeader>
            <CardContent>
              {here.length === 0 ? <p className="text-sm text-muted-foreground">{ai ? "None yet. Facts are grounded in the place's Wikipedia article." : "Add a Gemini or Claude API key to generate trivia."}</p> : null}
              <ul className="space-y-2 text-sm">
                {here.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <Badge variant="outline">{f.category}</Badge>
                    {f.kidFriendly ? <Badge variant="secondary">kids</Badge> : null}
                    <span className="flex-1">
                      {f.text}
                      {f.sourceUrl ? <> <a className="text-xs text-muted-foreground underline" href={f.sourceUrl} target="_blank" rel="noreferrer noopener">{f.sourceName ?? "source"}</a></> : null}
                    </span>
                    <form action={deleteTriviaFactAction}>
                      <input type="hidden" name="id" value={f.id} />
                      <input type="hidden" name="back" value={back} />
                      <button className="text-xs text-muted-foreground hover:text-destructive">remove</button>
                    </form>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
