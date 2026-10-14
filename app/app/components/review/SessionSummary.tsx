import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface SessionSummaryProps {
  elements: number;
  comments: number;
  unresolved: number;
  edits: number;
  pendingEdits: number;
  targets: string;
}

/** At-a-glance state of the review session, above the live preview. */
export function SessionSummary(props: SessionSummaryProps) {
  const stats = [
    { label: "Elements tagged", value: props.elements },
    { label: "Open comments", value: props.unresolved },
    { label: "Comments total", value: props.comments },
    { label: "Pending edits", value: props.pendingEdits },
    { label: "Edits total", value: props.edits },
  ];

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
        <div className="flex flex-col">
          <span className="text-xs text-muted-foreground">Target</span>
          <span className="max-w-56 truncate text-sm">{props.targets}</span>
        </div>
        {stats.map((stat) => (
          <div key={stat.label} className="flex flex-col">
            <span className="text-xs text-muted-foreground">{stat.label}</span>
            <span className="flex items-baseline gap-1 text-lg font-medium">
              {stat.value}
              {stat.label === "Pending edits" && stat.value > 0 ? (
                <Badge variant="secondary">uncommitted</Badge>
              ) : null}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}