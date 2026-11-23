// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// Configuration from the environment (README "Configure"). Secrets are read here and never
// printed; `describe()` is what start-up logs.

const list = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const stripSlash = (u) => u.replace(/\/+$/, "");

export function loadConfig(env = process.env) {
  const errors = [];
  const need = (k) => {
    const v = env[k];
    if (!v) errors.push(`${k} is required`);
    return v || "";
  };
  const cfg = {
    port: Number(env.PORT || 8090),
    publicUrl: stripSlash(need("MX_PUBLIC_URL")), // where Matrix clients load the widget
    ocUrl: stripSlash(need("OC_URL")), // OpenCanvas as browsers see it
    ocApiUrl: stripSlash(env.OC_API_URL || env.OC_URL || ""), // OpenCanvas as the bridge sees it
    hostId: need("OC_HOST_ID"),
    jwtSecret: need("OC_JWT_SECRET"),
    apiKey: env.OC_API_KEY || "",
    tokenTtlSecs: Number(env.OC_TOKEN_TTL || 600),
    botHomeserverUrl: stripSlash(need("MX_BOT_HOMESERVER_URL")),
    botAccessToken: need("MX_BOT_ACCESS_TOKEN"),
    botUserId: env.MX_BOT_USER_ID || "", // optional; looked up with whoami otherwise
    botAutojoin: env.MX_BOT_AUTOJOIN === "1",
    allowedServers: list(env.MX_ALLOWED_SERVERS),
    privateAllowed: list(env.MX_PRIVATE_ALLOWED),
    federationOverrides: {},
    memberRole: env.MX_MEMBER_ROLE || "edit",
  };
  if (env.MX_FEDERATION_OVERRIDES) {
    try {
      cfg.federationOverrides = JSON.parse(env.MX_FEDERATION_OVERRIDES);
    } catch {
      errors.push("MX_FEDERATION_OVERRIDES must be a JSON object");
    }
  }
  if (!["view", "comment", "edit"].includes(cfg.memberRole)) errors.push("MX_MEMBER_ROLE must be view, comment or edit");
  if (!(cfg.tokenTtlSecs >= 60 && cfg.tokenTtlSecs <= 3600)) errors.push("OC_TOKEN_TTL must be 60..3600 seconds");
  if (cfg.jwtSecret && cfg.jwtSecret.length < 32) errors.push("OC_JWT_SECRET must be at least 32 characters");
  return { cfg, errors };
}

export function describe(cfg) {
  return {
    port: cfg.port,
    publicUrl: cfg.publicUrl,
    ocUrl: cfg.ocUrl,
    hostId: cfg.hostId,
    allowedServers: cfg.allowedServers.length ? cfg.allowedServers : "any",
    privateAllowed: cfg.privateAllowed,
    overrides: Object.keys(cfg.federationOverrides),
    memberRole: cfg.memberRole,
    botAutojoin: cfg.botAutojoin,
  };
}
