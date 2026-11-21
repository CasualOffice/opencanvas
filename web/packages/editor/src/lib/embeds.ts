// Embed allow-list (docs/07): only these providers render as iframes, and only
// through the provider's own embed URL. Everything else becomes a link card.

export type Provider = "youtube" | "vimeo" | "loom" | "figma" | "maps";

export interface EmbedInfo {
  provider: Provider;
  label: string;
  src: string;
  tall?: boolean;
}

const LABEL: Record<Provider, string> = { youtube: "YouTube", vimeo: "Vimeo", loom: "Loom", figma: "Figma", maps: "Google Maps" };

/** The allow-listed providers, in picker order, with a URL shape to show as the example. */
export const PROVIDERS: { id: Provider; label: string; icon: string; example: string }[] = [
  { id: "youtube", label: LABEL.youtube, icon: "circle-play", example: "https://www.youtube.com/watch?v=…" },
  { id: "vimeo", label: LABEL.vimeo, icon: "circle-play", example: "https://vimeo.com/123456789" },
  { id: "loom", label: LABEL.loom, icon: "circle-play", example: "https://www.loom.com/share/…" },
  { id: "figma", label: LABEL.figma, icon: "pen-tool", example: "https://www.figma.com/design/…" },
  { id: "maps", label: LABEL.maps, icon: "map-pin", example: "https://www.google.com/maps/place/…" },
];

export function providerLabel(p: string): string {
  return LABEL[p as Provider] ?? "Embed";
}

export function resolveEmbed(raw: string): EmbedInfo | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const id = (s: string | null | undefined) => (s && /^[\w-]{3,64}$/.test(s) ? s : null);

  if (h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com") {
    let v: string | null = null;
    if (h === "youtu.be") v = id(u.pathname.slice(1));
    else if (u.pathname === "/watch") v = id(u.searchParams.get("v"));
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]+)/);
      v = id(m?.[1]);
    }
    if (!v) return null;
    const t = parseInt(u.searchParams.get("t") ?? "", 10);
    return { provider: "youtube", label: LABEL.youtube, src: `https://www.youtube-nocookie.com/embed/${v}${t > 0 ? `?start=${t}` : ""}` };
  }
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const m = u.pathname.match(/(\d{5,})/);
    if (!m) return null;
    return { provider: "vimeo", label: LABEL.vimeo, src: `https://player.vimeo.com/video/${m[1]}?dnt=1` };
  }
  if (h === "loom.com") {
    const m = u.pathname.match(/^\/(?:share|embed)\/([\w-]+)/);
    if (!id(m?.[1])) return null;
    return { provider: "loom", label: LABEL.loom, src: `https://www.loom.com/embed/${m![1]}` };
  }
  if (h === "figma.com") {
    if (!/^\/(file|design|proto|board)\//.test(u.pathname)) return null;
    return { provider: "figma", label: LABEL.figma, src: `https://www.figma.com/embed?embed_host=opencanvas&url=${encodeURIComponent(u.toString())}`, tall: true };
  }
  if ((h === "google.com" || h === "maps.google.com") && (u.pathname.startsWith("/maps") || h === "maps.google.com")) {
    if (u.pathname.startsWith("/maps/embed")) return { provider: "maps", label: LABEL.maps, src: u.toString(), tall: true };
    const place = u.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/)?.[1];
    const q = u.searchParams.get("q") ?? (place ? decodeURIComponent(place).replace(/\+/g, " ") : null);
    if (!q) return null;
    return { provider: "maps", label: LABEL.maps, src: `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`, tall: true };
  }
  return null;
}

export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-presentation allow-popups-to-escape-sandbox";
export const EMBED_ALLOW = "autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write";

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A link-preview card for `url`, as Tiptap JSON. */
export function bookmarkNode(url: string) {
  const site = hostOf(url);
  return { type: "bookmark", attrs: { url, title: site, description: "", site } };
}
