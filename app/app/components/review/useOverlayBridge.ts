import { useCallback, useEffect, useRef, useState } from "react";

import { callAction } from "@agent-native/core/client/hooks";

/** Element descriptor the overlay sends when the reviewer clicks something. */
export interface SelectedElement {
  id: string;
  selector: string;
  selectorAlternatives?: string[];
  tag?: string;
  text?: string;
  accessibleName?: string;
  role?: string;
  nearbyText?: string;
  page?: string;
  ancestors?: string[];
  attributes?: Record<string, string>;
  component?: { framework?: string; name?: string } | null;
}

export type OverlayMode = "off" | "inspect" | "text";

export interface OverlayNotice {
  text: string;
  kind: "ok" | "error" | "";
}

interface BridgeOptions {
  previewUrl: string | undefined;
  mode: OverlayMode;
  reloadKey: number;
  onOpenComments: number;
  onPendingEdits: number;
}

const MAX_TEXT = 4000;

/**
 * Bridge between the review workspace and UIDIT's injected page overlay.
 *
 * The overlay runs inside the previewed app on the UIDIT preview origin, so it
 * cannot call this app's actions directly. It asks its parent to relay each
 * `/api/*` call over `postMessage`, and this hook forwards them to the shared
 * actions -- the same ones the agent calls -- so both paths write one session.
 */
export function useOverlayBridge(options: BridgeOptions) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [notice, setNotice] = useState<OverlayNotice | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const pending = useRef(new Map<string, (msg: { ok: boolean; result?: unknown; error?: string }) => void>());

  const previewOrigin = useMemoOrigin(options.previewUrl);

  const toOverlay = useCallback(
    (message: Record<string, unknown>) => {
      const frame = frameRef.current?.contentWindow;
      if (!frame || !previewOrigin) return;
      frame.postMessage({ source: "uidit-dashboard", ...message }, previewOrigin);
    },
    [previewOrigin],
  );

  useEffect(() => {
    if (!previewOrigin) return;
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== previewOrigin) return;
      const msg = event.data as Record<string, unknown> | null;
      if (!msg || msg.source !== "uidit-overlay") return;
      const type = typeof msg.type === "string" ? msg.type : "";
      // Any message proves the overlay is live and can hear this window, which
      // is what the workspace shows. `ready` alone can be missed on a reload.
      setFrameReady(true);

      if (type === "ready") return;
      if (type === "selected") {
        setSelected((msg.element as SelectedElement | null) ?? null);
        return;
      }
      if (type === "error") {
        setNotice({ text: String(msg.message ?? "Preview error").slice(0, 300), kind: "error" });
        return;
      }
      if (type === "edited") {
        setNotice({ text: "Change previewed — commit it in source when it is applied", kind: "ok" });
        return;
      }
      if (type === "api-request") {
        const id = typeof msg.id === "string" ? msg.id : "";
        if (!id || id.length > 100) return;
        try {
          const result = await relayPreviewRequest(msg);
          frameRef.current?.contentWindow?.postMessage(
            { source: "uidit-dashboard", type: "api-response", id, ok: true, result },
            previewOrigin,
          );
          setNotice(null);
        } catch (error) {
          const message = (error as Error).message;
          frameRef.current?.contentWindow?.postMessage(
            { source: "uidit-dashboard", type: "api-response", id, ok: false, error: message },
            previewOrigin,
          );
          setNotice({ text: message, kind: "error" });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [previewOrigin]);

  // Push the current mode and counters into the overlay on every change.
  const syncMode = useCallback(() => {
    toOverlay({ type: "mode", mode: options.mode });
    toOverlay({
      type: "state",
      openComments: options.onOpenComments,
      pendingEdits: options.onPendingEdits,
    });
  }, [toOverlay, options.mode, options.onOpenComments, options.onPendingEdits]);

  useEffect(() => {
    if (!frameReady) return;
    syncMode();
  }, [frameReady, syncMode]);

  useEffect(() => {
    setSelected(null);
    setFrameReady(false);
  }, [options.reloadKey]);

  return { frameRef, previewOrigin, selected, setSelected, notice, setNotice, frameReady, toOverlay, syncMode };
}

/**
 * Forward one overlay request to the shared action it belongs to. The overlay's
 * own route names are kept here, so a new overlay route fails loudly instead of
 * being written somewhere unexpected.
 */
async function relayPreviewRequest(msg: Record<string, unknown>): Promise<unknown> {
  const route = typeof msg.route === "string" ? msg.route : "";
  const method = typeof msg.method === "string" ? msg.method : "POST";
  if (method !== "POST") throw new Error("Unsupported preview request");
  const body = (msg.body ?? {}) as Record<string, unknown>;

  if (route === "/element") {
    const element = elementOf(body);
    return callAction("tag-element", element, { method: "POST" });
  }
  if (route === "/comment") {
    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
    if (!text) throw new Error("Comment text must be 1–4000 characters");
    return callAction("add-comment", { text, elementId: elementIdOf(body) }, { method: "POST" });
  }
  if (route === "/comment-reply") {
    const commentId = typeof body.commentId === "string" ? body.commentId : "";
    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
    if (!commentId || !text) throw new Error("Reply text must be 1–4000 characters");
    return callAction("update-comment", { commentId, replyText: text }, { method: "POST" });
  }
  return callAction("add-edit", editOf(body), { method: "POST" });
}

function elementIdOf(body: Record<string, unknown>): string | undefined {
  return typeof body.elementId === "string" && body.elementId ? body.elementId : undefined;
}

interface TagElementInput {
  selector: string;
  selectorAlternatives?: string[];
  tag?: string;
  text?: string;
  accessibleName?: string;
  role?: string;
  nearbyText?: string;
  page?: string;
  ancestors?: string[];
  attributes?: Record<string, string>;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function boundedStrings(value: unknown, max: number, keep: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, keep)
    .map((item) => item.slice(0, max));
  return items.length ? items : undefined;
}

/**
 * The overlay describes an element richly and uses `null` for anything it could
 * not read (role, accessibleName, …). The action takes optional strings, so
 * unreadable fields are dropped instead of sent as null, which the schema
 * rejects -- and a rejection makes the overlay abandon the selection entirely.
 */
function elementOf(body: Record<string, unknown>): TagElementInput {
  const selector = typeof body.selector === "string" ? body.selector.slice(0, 2000) : "";
  if (!selector) throw new Error("Element selector is required");
  const element: TagElementInput = { selector };
  const enrichment: [keyof TagElementInput, string | undefined][] = [
    ["tag", boundedString(body.tag, 32)],
    ["text", boundedString(body.text, 300)],
    ["accessibleName", boundedString(body.accessibleName, 240)],
    ["role", boundedString(body.role, 80)],
    ["nearbyText", boundedString(body.nearbyText, 240)],
    ["page", boundedString(body.page, 2000)],
  ];
  for (const [field, value] of enrichment) {
    if (value) Object.assign(element, { [field]: value });
  }

  const alternatives = boundedStrings(body.selectorAlternatives, 2000, 12);
  if (alternatives) element.selectorAlternatives = alternatives;
  const ancestors = boundedStrings(body.ancestors, 120, 5);
  if (ancestors) element.ancestors = ancestors;

  if (body.attributes && typeof body.attributes === "object") {
    const attributes = Object.fromEntries(
      Object.entries(body.attributes as Record<string, unknown>)
        .filter(([, value]) => typeof value === "string")
        .slice(0, 12)
        .map(([key, value]) => [key.slice(0, 80), String(value).slice(0, 300)]),
    );
    if (Object.keys(attributes).length) element.attributes = attributes;
  }
  return element;
}

const EDIT_KINDS = ["text", "style", "class", "attribute", "remove"] as const;
type EditKind = (typeof EDIT_KINDS)[number];

// Mirrors the add-edit allowlist. Kept as a literal array so narrowing a value
// against it produces the exact union the action accepts, instead of `string`.
const STYLE_PROPERTIES = [
  "padding", "margin", "gap", "display", "align-items", "justify-content",
  "grid-template-columns", "font-size", "font-weight", "line-height",
  "letter-spacing", "color", "background-color", "border", "border-radius",
  "box-shadow", "opacity", "width", "max-width", "min-height", "text-align",
] as const;

function editOf(body: Record<string, unknown>) {
  const elementId = typeof body.elementId === "string" ? body.elementId : "";
  if (!elementId) throw new Error("An edit needs the element it applies to");
  const kind = EDIT_KINDS.find((candidate) => candidate === body.kind) ?? "text";
  const raw = typeof body.property === "string" ? body.property.slice(0, 100) : undefined;
  // A style edit must name an allowlisted CSS property; class and attribute
  // edits carry the class/attribute name instead. The action enforces the
  // style allowlist, so a bogus style property is rejected there, not here.
  const styleProperty = raw ? STYLE_PROPERTIES.find((candidate) => candidate === raw) : undefined;
  const property = kind === "style" ? styleProperty : raw;
  return {
    elementId,
    kind,
    before: body.before == null ? undefined : String(body.before).slice(0, 2000),
    after: body.after == null ? undefined : String(body.after).slice(0, 2000),
    ...(property ? { property } : {}),
  };
}

function useMemoOrigin(previewUrl: string | undefined) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    try {
      setOrigin(previewUrl ? new URL(previewUrl).origin : "");
    } catch {
      setOrigin("");
    }
  }, [previewUrl]);
  return origin;
}