import { useState } from "react";

import { Button } from "@/components/ui/button";

export const VIEWPORTS = [
  { id: "desktop", label: "Desktop", width: 1440, icon: "▭" },
  { id: "laptop", label: "Laptop", width: 1180, icon: "▭" },
  { id: "tablet", label: "Tablet", width: 834, icon: "▯" },
  { id: "phone", label: "Phone", width: 390, icon: "▏" },
] as const;

export type ViewportId = (typeof VIEWPORTS)[number]["id"];

interface ViewportSwitcherProps {
  viewport: ViewportId;
  onChange: (viewport: ViewportId) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
  inspect: boolean;
  onInspectChange: (inspecting: boolean) => void;
  onReload: () => void;
}

/**
 * Preview controls. The viewport widths resize the embedded preview so a change
 * can be checked at more than one size; they do not emulate device hardware.
 */
export function ViewportSwitcher(props: ViewportSwitcherProps) {
  const [compare, setCompare] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border p-1">
        {VIEWPORTS.map((entry) => (
          <Button
            key={entry.id}
            size="sm"
            variant={props.viewport === entry.id ? "secondary" : "ghost"}
            onClick={() => props.onChange(entry.id)}
            title={`${entry.label} — ${entry.width}px wide`}
          >
            <span aria-hidden>{entry.icon}</span>
            <span className="sr-only">{entry.label}</span>
          </Button>
        ))}
      </div>

      <Button
        size="sm"
        variant={compare ? "secondary" : "outline"}
        onClick={() => setCompare((value) => !value)}
        title="Show the preview at two widths side by side"
      >
        Compare
      </Button>

      <Button
        size="sm"
        variant={props.inspect ? "default" : "outline"}
        onClick={() => props.onInspectChange(!props.inspect)}
      >
        {props.inspect ? "Inspecting" : "Inspect"}
      </Button>

      <Button
        size="sm"
        variant="outline"
        onClick={() => props.onThemeChange(props.theme === "light" ? "dark" : "light")}
        title="Toggle the preview theme"
      >
        {props.theme === "light" ? "Dark" : "Light"}
      </Button>

      <Button size="sm" variant="outline" onClick={props.onReload}>
        Reload
      </Button>
    </div>
  );
}

export function viewportWidth(viewport: ViewportId): number {
  return VIEWPORTS.find((entry) => entry.id === viewport)?.width ?? 1440;
}