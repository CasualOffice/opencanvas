// Shared contracts between the editor shell and the block packages.
// Keep this file small and stable: @opencanvas/editor, @opencanvas/database
// and @opencanvas/board all import from it.

export type Role = "view" | "comment" | "edit";
export type Tone = "gray" | "blue" | "green" | "amber" | "red" | "purple" | "pink";

export interface OcUser {
  id: string;
  name: string;
  /** CSS colour, assigned by the server from the session grant. */
  color: string;
  avatar?: string;
}

/** What every embedded block view (database, board) receives from the editor. */
export interface BlockEnv {
  role: Role;
  me: OcUser;
  /** People who can be assigned/mentioned (host-resolved). */
  users: OcUser[];
  /** True below 720px wide (side panel, phone). */
  compact: boolean;
  /** Show a short toast in the editor chrome. */
  toast: (message: string, action?: { label: string; run: () => void }) => void;
  /**
   * Optional: store a file (image dropped on a board, …) and return its URL. Without it blocks
   * fall back to an inline data: URL (capped at 2 MB).
   */
  upload?: (file: File) => Promise<{ url: string }>;
}

export const USER_PALETTE = ["#2a5ad7", "#7a45f0", "#e5602a", "#0e9a78", "#d63f78", "#b7791f", "#0b7fa6", "#6b7280"];

export function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
}
