import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import type { SelectedElement } from "./useOverlayBridge";

const STYLE_PROPERTIES = [
  "padding",
  "margin",
  "gap",
  "display",
  "align-items",
  "justify-content",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "border-radius",
  "border",
  "box-shadow",
  "opacity",
  "width",
  "max-width",
  "text-align",
] as const;

type StyleProperty = (typeof STYLE_PROPERTIES)[number];

interface ElementInspectorProps {
  element: SelectedElement;
  onComment: (text: string) => void;
  onStyle: (property: string, value: string) => void;
  onText: (previous: string) => void;
  onAttribute: (property: string, value: string | null) => void;
  onToggleClass: (name: string) => void;
  onHide: () => void;
  onRevert: () => void;
  onClear: () => void;
}

/**
 * Editor for the element currently selected in the live preview.
 *
 * Every control hands the change to the overlay, which applies it to the real
 * DOM in the previewed page and records the before → after edit through the
 * bridge. The panel never mutates the session itself.
 */
export function ElementInspector(props: ElementInspectorProps) {
  const { element } = props;
  const [property, setProperty] = useState<StyleProperty>("padding");
  const [value, setValue] = useState("16px");
  const [attributeName, setAttributeName] = useState("");
  const [attributeValue, setAttributeValue] = useState("");
  const [className, setClassName] = useState("");
  const [comment, setComment] = useState("");

  const classes = element.attributes?.class ?? "";

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <Badge variant="outline">{element.tag ?? "?"}</Badge>
          {element.role ? <Badge variant="outline">{element.role}</Badge> : null}
          <code className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {element.selector}
          </code>
        </div>

        <div className="flex items-start gap-2">
          <Input
            aria-label="New text"
            value={element.text ?? ""}
            onChange={(event) =>
              props.onText(element.text ?? "")
            }
            placeholder="Element text"
            readOnly
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => props.onText(element.text ?? "")}
            title="Edit this text in place"
          >
            Edit text
          </Button>
        </div>

        <div className="grid grid-cols-[9rem_minmax(0,1fr)_auto] items-center gap-2">
          <select
            aria-label="CSS property"
            className="h-9 rounded-md border bg-transparent px-2 text-sm"
            value={property}
            onChange={(event) => setProperty(event.target.value as StyleProperty)}
          >
            {STYLE_PROPERTIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <Input
            aria-label="CSS value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) props.onStyle(property, value.trim());
            }}
          />
          <Button size="sm" disabled={!value.trim()} onClick={() => props.onStyle(property, value.trim())}>
            Apply
          </Button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
          <Input
            aria-label="Class name"
            value={className}
            onChange={(event) => setClassName(event.target.value)}
            placeholder="class name"
          />
          <Input aria-label="Current classes" value={classes} readOnly placeholder="current classes" />
          <Button
            size="sm"
            variant="outline"
            disabled={!className.trim()}
            onClick={() => props.onToggleClass(className.trim())}
          >
            Toggle
          </Button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
          <Input
            aria-label="Attribute name"
            value={attributeName}
            onChange={(event) => setAttributeName(event.target.value)}
            placeholder="attribute"
          />
          <Input
            aria-label="Attribute value"
            value={attributeValue}
            onChange={(event) => setAttributeValue(event.target.value)}
            placeholder="value"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={!attributeName.trim()}
            onClick={() =>
              props.onAttribute(
                attributeName.trim(),
                attributeValue === "" ? null : attributeValue,
              )
            }
          >
            Set
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={props.onHide}>
            Hide element
          </Button>
          <Button size="sm" variant="outline" onClick={props.onRevert}>
            Revert preview changes
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onClear}>
            Deselect
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-t pt-3">
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={`Comment on ${element.selector}`}
          />
          <div>
            <Button
              size="sm"
              disabled={!comment.trim()}
              onClick={() => {
                props.onComment(comment.trim());
                setComment("");
              }}
            >
              Comment on this element
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}