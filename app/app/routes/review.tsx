import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ElementsBrowser, type TaggedElement } from "@/components/review/ElementsBrowser";
import { ElementInspector } from "@/components/review/ElementInspector";
import { SessionSummary } from "@/components/review/SessionSummary";
import { useOverlayBridge, type OverlayMode } from "@/components/review/useOverlayBridge";
import { ViewportSwitcher, viewportWidth, type ViewportId } from "@/components/review/ViewportSwitcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export function meta() {
  return [{ title: "Review" }];
}

type Tab = "feedback" | "elements" | "changes";

const TABS: { id: Tab; label: string }[] = [
  { id: "feedback", label: "Feedback" },
  { id: "elements", label: "Elements" },
  { id: "changes", label: "Changes" },
];

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
  const [mode, setMode] = useState<OverlayMode>("off");
  const [reloadKey, setReloadKey] = useState(0);
  const [viewport, setViewport] = useState<ViewportId>("desktop");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [tab, setTab] = useState<Tab>("feedback");
  const [pageComment, setPageComment] = useState("");

  const config = useActionQuery("get-review-config", {});
  const { data, isPending } = useActionQuery("list-feedback", { includeResolved });
  const addComment = useActionMutation("add-comment");
  const updateComment = useActionMutation("update-comment");
  const markEditApplied = useActionMutation("mark-edit-applied");

  const counts = data?.counts;
  const bridge = useOverlayBridge({
    previewUrl: config.data?.previewUrl,
    mode,
    reloadKey,
    onOpenComments: counts?.unresolvedComments ?? 0,
    onPendingEdits: counts?.pendingEdits ?? 0,
  });

  const reportError = (fallback: string) => (error: unknown) =>
    toast.error(actionErrorMessage(error as Error) ?? fallback);

  // i toggles inspect, Escape leaves it -- the same shortcuts the overlay sends.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "i") setMode((current) => (current === "inspect" ? "off" : "inspect"));
      if (event.key === "Escape") setMode("off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    bridge.toOverlay({ type: "theme", theme });
  }, [theme, bridge.toOverlay]);

  const previewUrl = config.data?.previewUrl;
  const width = viewportWidth(viewport);
  const selectors = new Map((data?.elements ?? []).map((element) => [element.id, element.selector]));

  if (isPending || config.isPending) {
    return (
      <div className="grid h-full gap-4 p-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <Skeleton className="h-full min-h-96 w-full" />
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const frame = (
    <iframe
      key={reloadKey}
      ref={bridge.frameRef}
      title="Live application preview"
      className="h-full w-full border-0"
      style={{ width: `${width}px`, maxWidth: "100%" }}
      src={previewUrl ? `${previewUrl}/proxy/?r=${reloadKey}` : undefined}
      onLoad={bridge.syncMode}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <ViewportSwitcher
          viewport={viewport}
          onChange={setViewport}
          theme={theme}
          onThemeChange={setTheme}
          inspect={mode === "inspect"}
          onInspectChange={(inspecting) => setMode(inspecting ? "inspect" : "off")}
          onReload={() => setReloadKey((key) => key + 1)}
        />
        <Badge variant="outline">{width}px</Badge>
        <Badge variant={bridge.frameReady ? "secondary" : "outline"}>
          {bridge.frameReady ? "Preview connected" : "Connecting to preview…"}
        </Badge>
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeResolved}
            onChange={(event) => setIncludeResolved(event.target.checked)}
          />
          Show resolved
        </label>
      </header>

      {bridge.notice ? (
        <p
          className={
            bridge.notice.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
          }
        >
          {bridge.notice.text}
        </p>
      ) : null}

      <SessionSummary
        elements={data?.elements.length ?? 0}
        comments={data?.comments.length ?? 0}
        unresolved={counts?.unresolvedComments ?? 0}
        edits={data?.edits.length ?? 0}
        pendingEdits={counts?.pendingEdits ?? 0}
        targets={config.data?.targetUrl ?? "no target configured"}
      />

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <section className="flex min-h-0 flex-col gap-2">
          {config.data?.hasTarget === false ? (
            <Card>
              <CardContent className="py-3 text-sm text-muted-foreground">
                No target URL is configured. Start your dev server, or run{" "}
                <code className="text-xs">uidit --attach http://127.0.0.1:3000</code>, to review a
                page here.
              </CardContent>
            </Card>
          ) : null}
          {mode === "inspect" ? (
            <p className="text-sm text-muted-foreground">
              Click an element in the preview to select it. Press <kbd>i</kbd> or{" "}
              <kbd>Escape</kbd> to stop.
            </p>
          ) : null}
          <div className="flex min-h-96 flex-1 justify-center overflow-auto rounded-lg border bg-white">
            {frame}
          </div>
        </section>

        <section className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
          {bridge.selected ? (
            <ElementInspector
              element={bridge.selected}
              onComment={(text) =>
                addComment.mutate(
                  { text, ...(bridge.selected?.id ? { elementId: bridge.selected.id } : {}) },
                  { onError: reportError("Could not record comment") },
                )
              }
              onStyle={(property, value) => bridge.toOverlay({ type: "style", property, value })}
              onText={(previous) => bridge.toOverlay({ type: "commitText", previous })}
              onAttribute={(property, value) => bridge.toOverlay({ type: "attribute", property, value })}
              onToggleClass={(name) => bridge.toOverlay({ type: "toggleClass", name })}
              onHide={() => bridge.toOverlay({ type: "remove" })}
              onRevert={() => bridge.toOverlay({ type: "revert" })}
              onClear={() => bridge.setSelected(null)}
            />
          ) : null}

          <div className="flex items-center gap-1 border-b">
            {TABS.map((entry) => (
              <Button
                key={entry.id}
                size="sm"
                variant={tab === entry.id ? "secondary" : "ghost"}
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>

          {tab === "feedback" ? (
            <>
              {data?.comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No open feedback. Tag an element in the preview to start a thread.
                </p>
              ) : (
                data?.comments.map((comment) => (
                  <Card key={comment.id}>
                    <CardContent className="flex flex-col gap-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge variant={comment.resolved ? "secondary" : "outline"}>
                          {comment.resolved ? "resolved" : comment.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {relative(comment.createdAt)}
                        </span>
                        {comment.replyCount > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {comment.replyCount}{" "}
                            {comment.replyCount === 1 ? "reply" : "replies"}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm">{comment.text}</p>
                      {comment.selector ? (
                        <button
                          type="button"
                          className="truncate text-left text-xs text-muted-foreground hover:underline"
                          onClick={() => bridge.toOverlay({ type: "flashSelector", selector: comment.selector ?? "" })}
                          title="Highlight in the preview"
                        >
                          {comment.selector}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground">Whole page</span>
                      )}
                      {!comment.resolved ? (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={updateComment.isPending}
                            onClick={() =>
                              updateComment.mutate(
                                { commentId: comment.id, status: "implemented" },
                                { onError: reportError("Could not update comment") },
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
                                { onError: reportError("Could not resolve comment") },
                              )
                            }
                          >
                            Resolve
                          </Button>
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                ))
              )}

              <div className="flex flex-col gap-2">
                <Textarea
                  value={pageComment}
                  onChange={(event) => setPageComment(event.target.value)}
                  placeholder="Comment on the page as a whole…"
                />
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!pageComment.trim() || addComment.isPending}
                    onClick={() =>
                      addComment.mutate(
                        { text: pageComment },
                        {
                          onSuccess: () => setPageComment(""),
                          onError: reportError("Could not record comment"),
                        },
                      )
                    }
                  >
                    Comment on page
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {tab === "elements" ? (
            <ElementsBrowser
              elements={(data?.elements ?? []) as TaggedElement[]}
              selectedId={bridge.selected?.id}
              onHighlight={(selector) => bridge.toOverlay({ type: "flashSelector", selector })}
              onComment={(elementId, text) =>
                addComment.mutate(
                  { text, elementId },
                  { onError: reportError("Could not record comment") },
                )
              }
            />
          ) : null}

          {tab === "changes" ? (
            <>
              {data?.edits.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No preview edits yet. Select an element and try a style, text, class, or attribute
                  change.
                </p>
              ) : (
                data?.edits.map((edit) => (
                  <Card key={edit.id}>
                    <CardContent className="flex flex-wrap items-center gap-2">
                      <Badge variant={edit.applied ? "secondary" : "outline"}>
                        {edit.applied ? "committed" : "pending"}
                      </Badge>
                      <Badge variant="outline">{edit.kind}</Badge>
                      <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {selectors.get(edit.elementId ?? "") ?? "unattached"}
                      </code>
                      <code className="text-xs">
                        {edit.property ? `${edit.property}: ` : ""}
                        {edit.before ?? "unset"} → {edit.after ?? "removed"}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={markEditApplied.isPending}
                        onClick={() =>
                          markEditApplied.mutate(
                            { editId: edit.id, applied: !edit.applied },
                            { onError: reportError("Could not update edit") },
                          )
                        }
                      >
                        {edit.applied ? "Uncommit" : "Commit"}
                      </Button>
                    </CardContent>
                  </Card>
                ))
              )}
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}