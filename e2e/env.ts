import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OC = "http://localhost:8280";
export const HOST = "http://localhost:4200";
export const HOST_RELOAD = "http://localhost:4201";
