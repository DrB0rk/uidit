import { actionErrorMessage, useActionMutation, useActionQuery } from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { toast } from "sonner";

export function meta() {
  return [{ title: "Review" }];
}

export default function ReviewRoute() {
  useSetPageTitle("Review");
  const [includeResolved, setIncludeResolved] = useState(false);
  const { data, isPending } = useActionQuery("list-feedback", { includeResolved });
  const addComment = useActionMutation("add-comment");
  const updateComment = useActionMutation("update-comment");
  const addEdit = useActionMutation("add-edit");
  const markEditApplied = useActionMutation("mark-edit-applied");
  const [commentText, setCommentText] = useState("");

  if (isPending) {
    return (
      <div className="mx-auto grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <section className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-medium">Review queue</h2>
        <Badge variant="secondary">{data?.counts.openComments ?? 0} open</Badge>
        <Badge variant="secondary">{data?.counts.pendingEdits ?? 0} pending edits</Badge>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Show resolved
        </label>
      </section>

      <section className="grid gap-3">
        {data?.comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open feedback in this session.</p>
        ) : (
          data?.comments.map((comment) => (
            <Card key={comment.id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Badge variant="outline">{comment.status}</Badge>
                  <p className="flex-1 text-sm">{comment.text}</p>
                </div>
                {comment.selector ? (
                  <code className="text-xs text-muted-foreground">{comment.selector}</code>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={updateComment.isPending}
                    onClick={() =>
                      updateComment.mutate(
                        { commentId: comment.id, status: "implemented" },
                        {
                          onError: (error) =>
                            toast.error(actionErrorMessage(error) ?? "Could not update comment"),
                        },
                      )
                    }
                  >
                    Mark implemented
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={updateComment.isPending}
                    onClick={() =>
                      updateComment.mutate(
                        { commentId: comment.id, status: "verified" },
                        {
                          onError: (error) =>
                            toast.error(actionErrorMessage(error) ?? "Could not resolve comment"),
                        },
                      )
                    }
                  >
                    Resolve
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Add feedback</h3>
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
                  onError: (error) =>
                    toast.error(actionErrorMessage(error) ?? "Could not record comment"),
                },
              )
            }
          >
            Record comment
          </Button>
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Tagged elements</h3>
        {data?.elements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No elements tagged yet.</p>
        ) : (
          data?.elements.map((element) => (
            <div key={element.id} className="flex items-center gap-3 text-sm">
              <Badge variant="outline">{element.tag ?? "?"}</Badge>
              <code className="flex-1 truncate text-xs text-muted-foreground">{element.selector}</code>
              {element.text ? <span className="truncate">{element.text}</span> : null}
            </div>
          ))
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-medium text-muted-foreground">Preview edits</h3>
        {data?.edits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No preview edits recorded.</p>
        ) : (
          data?.edits.map((edit) => (
            <div key={edit.id} className="flex items-center gap-3 text-sm">
              <Badge variant={edit.applied ? "secondary" : "outline"}>
                {edit.applied ? "committed" : "pending"}
              </Badge>
              <code className="flex-1 truncate text-xs text-muted-foreground">
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
                    {
                      onError: (error) =>
                        toast.error(actionErrorMessage(error) ?? "Could not update edit"),
                    },
                  )
                }
              >
                {edit.applied ? "Uncommit" : "Commit"}
              </Button>
            </div>
          ))
        )}
        <ProposedEditForm
          elements={data?.elements ?? []}
          onSubmit={(values) =>
            addEdit.mutate(values, {
              onSuccess: () => toast.success("Edit proposed"),
              onError: (error) => toast.error(actionErrorMessage(error) ?? "Could not record edit"),
            })
          }
          pending={addEdit.isPending}
        />
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
    kind: "style" | "text" | "class" | "attribute";
    property?: "padding" | "margin" | "color";
    after: string;
    before?: string;
  }) => void;
  pending: boolean;
}) {
  const [elementId, setElementId] = useState("");
  const [property, setProperty] = useState<"padding" | "margin" | "color">("padding");
  const [after, setAfter] = useState("16px");

  return (
    <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_auto_auto_auto]">
      <select
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
        className="h-9 rounded-md border bg-transparent px-2 text-sm"
        value={property}
        onChange={(event) => setProperty(event.target.value as typeof property)}
      >
        <option value="padding">padding</option>
        <option value="margin">margin</option>
        <option value="color">color</option>
      </select>
      <Input value={after} onChange={(event) => setAfter(event.target.value)} />
      <Button
        disabled={!elementId || !after || pending}
        onClick={() => onSubmit({ elementId, kind: "style", property, after })}
      >
        Propose
      </Button>
    </div>
  );
}