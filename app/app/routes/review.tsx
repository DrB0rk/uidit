import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export function meta() {
  return [{ title: "Review" }];
}

const relative = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

export default function ReviewRoute() {
  useSetPageTitle("Review");
  const [includeResolved, setIncludeResolved] = useState(false);
  const { data, isPending } = useActionQuery("list-feedback", { includeResolved });
  const addComment = useActionMutation("add-comment");
  const updateComment = useActionMutation("update-comment");
  const addEdit = useActionMutation("add-edit");
  const markEditApplied = useActionMutation("mark-edit-applied");
  const [commentText, setCommentText] = useState("");

  const reportError = (fallback: string) => (error: unknown) =>
    toast.error(actionErrorMessage(error as Error) ?? fallback);

  if (isPending) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  const selectors = new Map((data?.elements ?? []).map((element) => [element.id, element.selector]));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{data?.counts.unresolvedComments ?? 0} unresolved</Badge>
          <Badge variant="secondary">{data?.counts.unclaimedComments ?? 0} unclaimed</Badge>
          <Badge variant="secondary">{data?.counts.pendingEdits ?? 0} pending edits</Badge>
        </div>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Show resolved
        </label>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Open feedback</h2>
        {data?.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing open. Tag an element on the running page to start a thread.
          </p>
        ) : (
          data?.comments.map((comment) => {
            const resolved = comment.status === "verified" || comment.status === "accepted";
            return (
              <Card key={comment.id}>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Badge variant={resolved ? "secondary" : "outline"}>{comment.status}</Badge>
                    <span className="text-xs text-muted-foreground">{relative(comment.createdAt)}</span>
                    {comment.replyCount > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {comment.replyCount} {comment.replyCount === 1 ? "reply" : "replies"}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm">{comment.text}</p>
                  {comment.selector ? (
                    <code className="truncate text-xs text-muted-foreground">{comment.selector}</code>
                  ) : (
                    <span className="text-xs text-muted-foreground">Whole page</span>
                  )}
                  {!resolved ? (
                    <div className="flex flex-wrap gap-2">
                      {comment.status === "open" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={updateComment.isPending}
                          onClick={() =>
                            updateComment.mutate(
                              { commentId: comment.id, status: "in_progress" },
                              { onError: reportError("Could not claim this comment") },
                            )
                          }
                        >
                          Claim
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={updateComment.isPending}
                        onClick={() =>
                          updateComment.mutate(
                            { commentId: comment.id, status: "implemented" },
                            { onError: reportError("Could not update this comment") },
                          )
                        }
                      >
                        Mark implemented
                      </Button>
                      <Button
                        size="sm"
                        disabled={updateComment.isPending}
                        onClick={() =>
                          updateComment.mutate(
                            { commentId: comment.id, status: "verified" },
                            { onError: reportError("Could not resolve this comment") },
                          )
                        }
                      >
                        Resolve
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Add feedback</h2>
        <Textarea
          value={commentText}
          onChange={(event) => setCommentText(event.target.value)}
          placeholder="What looks wrong on this page?"
        />
        <div>
          <Button
            disabled={!commentText.trim() || addComment.isPending}
            onClick={() =>
              addComment.mutate(
                { text: commentText },
                {
                  onSuccess: () => setCommentText(""),
                  onError: reportError("Could not record this comment"),
                },
              )
            }
          >
            Record comment
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Preview edits</h2>
        {data?.edits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No preview edits recorded.</p>
        ) : (
          data?.edits.map((edit) => (
            <Card key={edit.id}>
              <CardContent className="flex flex-wrap items-center gap-3">
                <Badge variant={edit.applied ? "secondary" : "outline"}>
                  {edit.applied ? "committed" : "pending"}
                </Badge>
                <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {selectors.get(edit.elementId ?? "") ?? "unattached"}
                </code>
                <code className="text-xs">
                  {edit.property ? `${edit.property}: ` : ""}
                  {edit.before ?? "unset"} → {edit.after}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={markEditApplied.isPending}
                  onClick={() =>
                    markEditApplied.mutate(
                      { editId: edit.id, applied: !edit.applied },
                      { onError: reportError("Could not update this edit") },
                    )
                  }
                >
                  {edit.applied ? "Uncommit" : "Commit"}
                </Button>
              </CardContent>
            </Card>
          ))
        )}
        <ProposedEditForm
          elements={data?.elements ?? []}
          pending={addEdit.isPending}
          onSubmit={(values) =>
            addEdit.mutate(values, {
              onSuccess: () => toast.success("Edit proposed"),
              onError: reportError("Could not record this edit"),
            })
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Tagged elements</h2>
        {data?.elements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No elements tagged yet.</p>
        ) : (
          data?.elements.map((element) => (
            <div key={element.id} className="flex items-baseline gap-3 text-sm">
              <Badge variant="outline">{element.tag ?? "?"}</Badge>
              <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {element.selector}
              </code>
              {element.text ? (
                <span className="max-w-40 shrink-0 truncate text-xs">{element.text}</span>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function ProposedEditForm({
  elements,
  onSubmit,
  pending,
}: {
  elements: { id: string; selector: string }[];
  onSubmit: (values: {
    elementId: string;
    kind: "style";
    property: "padding" | "margin" | "color";
    after: string;
  }) => void;
  pending: boolean;
}) {
  const [elementId, setElementId] = useState("");
  const [property, setProperty] = useState<"padding" | "margin" | "color">("padding");
  const [after, setAfter] = useState("16px");

  return (
    <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
      <select
        aria-label="Element"
        className="h-9 rounded-md border bg-transparent px-2 text-sm"
        value={elementId}
        onChange={(event) => setElementId(event.target.value)}
      >
        <option value="">Select an element</option>
        {elements.map((element) => (
          <option key={element.id} value={element.id}>
            {element.selector}
          </option>
        ))}
      </select>
      <select
        aria-label="Property"
        className="h-9 rounded-md border bg-transparent px-2 text-sm"
        value={property}
        onChange={(event) => setProperty(event.target.value as typeof property)}
      >
        <option value="padding">padding</option>
        <option value="margin">margin</option>
        <option value="color">color</option>
      </select>
      <Input aria-label="New value" value={after} onChange={(event) => setAfter(event.target.value)} />
      <Button
        disabled={!elementId || !after || pending}
        onClick={() => onSubmit({ elementId, kind: "style", property, after })}
      >
        Propose
      </Button>
    </div>
  );
}
