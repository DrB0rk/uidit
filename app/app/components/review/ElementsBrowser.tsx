import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface TaggedElement {
  id: string;
  selector: string;
  tag?: string | null;
  text?: string | null;
  route?: string | null;
  anchorStatus?: string;
}

interface ElementsBrowserProps {
  elements: TaggedElement[];
  selectedId?: string;
  onHighlight: (selector: string) => void;
  onComment: (elementId: string, text: string) => void;
}

/** Everything tagged this session, with jump-to and comment affordances. */
export function ElementsBrowser(props: ElementsBrowserProps) {
  const [query, setQuery] = useState("");
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? props.elements.filter(
        (element) =>
          element.selector.toLowerCase().includes(needle) ||
          (element.text ?? "").toLowerCase().includes(needle),
      )
    : props.elements;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by selector or text…"
          aria-label="Filter elements"
        />

        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {props.elements.length === 0
              ? "Nothing tagged yet. Turn on Inspect and click an element in the preview."
              : "No element matches that filter."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {matches.map((element) => (
              <li key={element.id} className="flex flex-col gap-1 border-b pb-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{element.tag ?? "?"}</Badge>
                  {element.anchorStatus && element.anchorStatus !== "located" ? (
                    <Badge variant="secondary">{element.anchorStatus}</Badge>
                  ) : null}
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono text-xs hover:underline"
                    onClick={() => props.onHighlight(element.selector)}
                    title="Highlight in the preview"
                  >
                    {element.selector}
                  </button>
                </div>
                {element.text ? (
                  <p className="truncate pl-2 text-xs text-muted-foreground">{element.text}</p>
                ) : null}
                {draftFor === element.id ? (
                  <div className="flex gap-2 pl-2">
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Comment on this element…"
                      aria-label="Comment"
                    />
                    <Button
                      size="sm"
                      disabled={!draft.trim()}
                      onClick={() => {
                        props.onComment(element.id, draft.trim());
                        setDraft("");
                        setDraftFor(null);
                      }}
                    >
                      Save
                    </Button>
                  </div>
                ) : (
                  <div className="pl-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => setDraftFor(element.id)}
                    >
                      Comment
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}