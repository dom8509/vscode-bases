// How a view looks, as Obsidian writes it in the view: `rowHeight` for a
// table; `cardSize`, `image`, `imageFit` and `imageAspectRatio` for cards
// (and the cover image for a board). Kept apart from base.ts so the webview
// can use it without bundling the whole engine.

import type { ViewConfig } from "./base";

export type RowHeight = "short" | "medium" | "tall" | "extra-tall";

/** How a view looks: row height for a table; card width and cover image for cards and boards. */
export interface ViewDisplay {
  rowHeight: RowHeight;
  /** Card width in pixels; Obsidian's default is 200. */
  cardSize: number;
  /** The property that holds a card's cover: an attachment link, a URL or a hex color. */
  image?: string;
  imageFit: "cover" | "contain";
  /** Image height divided by width; 1 is square. */
  imageAspectRatio: number;
}

export const DEFAULT_CARD_SIZE = 200;

export function displayOf(view: ViewConfig): ViewDisplay {
  // "extra tall", "extra-tall" and "extraTall" all mean the same.
  const rh = String(view.rowHeight ?? "").toLowerCase().replace(/[\s_-]/g, "");
  const num = (v: unknown, min: number, max: number, fallback: number) => {
    const n = typeof v === "number" ? v : Number.parseFloat(String(v));
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    rowHeight: rh === "medium" || rh === "tall" ? rh : rh === "extratall" ? "extra-tall" : "short",
    cardSize: num(view.cardSize, 50, 800, DEFAULT_CARD_SIZE),
    image: typeof view.image === "string" && view.image.trim() ? view.image.trim() : undefined,
    imageFit: String(view.imageFit ?? "").toLowerCase() === "contain" ? "contain" : "cover",
    imageAspectRatio: num(view.imageAspectRatio, 0.25, 4, 1),
  };
}
