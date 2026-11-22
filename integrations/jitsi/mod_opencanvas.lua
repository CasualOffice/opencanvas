-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
--
-- mod_opencanvas: opens an OpenCanvas canvas in a Jitsi Meet call, in the shared-document
-- slot Etherpad uses. Load it on the MUC component (docker-jitsi-meet: XMPP_MUC_MODULES).
--
-- How it works
--   * Jitsi's client reads the <etherpad> element of any occupant presence it receives
--     (jitsi-meet react/features/etherpad/middleware.ts), resolves the value against
--     config.etherpad_base, requires the same origin, and opens it in the shared-document
--     iframe. ETHERPAD_PUBLIC_URL therefore points at OpenCanvas.
--   * This module rewrites every presence the room delivers so that <etherpad> carries
--     <opencanvas_url>/v1/launch?token=<HS256 JWT minted for THAT recipient> (docs/05 §3).
--     Any <etherpad> someone else put there (Jicofo, a client) is removed first, so there is
--     exactly one source.
--   * file.id is a hash of the room JID (which includes the tenant) and Jitsi's meeting id
--     (mod_muc_meeting_id, room._data.meetingId), so a new meeting under the same name gets a
--     fresh canvas.
--   * When the room is destroyed it calls DELETE /v1/files/{fileId}/session (host API key),
--     asynchronously; a failure is only logged, the idle timeout ends the canvas anyway.
--
-- Where the per-recipient rewrite happens, and why there
--   Prosody's MUC (plugins/muc/muc.lib.lua, 0.12) builds a presence once and hands the SAME
--   stanza object to every recipient: publicise_occupant_status() fires
--   "muc-build-occupant-presence" and "muc-broadcast-presence" once per broadcast (not per
--   recipient), then calls route_to_occupant(), which only rewrites stanza.attr.to in a loop
--   and calls room:route_stanza(stanza). send_occupant_list() (the roster a joiner receives)
--   and the joiner's own status-110 presence also end in room:route_stanza(). So:
--     - "muc-broadcast-presence" / "muc-build-occupant-presence": one event for N recipients;
--       a token set there would be shared by everyone (wrong user, and single-use jti).
--     - "muc-occupant-pre-join": fires for the joiner's incoming presence, not deliveries.
--     - "pre-presence/full": core/stanza_router.lua only fires pre-events for stanzas that
--       arrive from a c2s session (core_post_stanza(origin, stanza, preevents=true)); the
--       MUC's module:send() never triggers it.
--     - "presence/full" on the user's VirtualHost is per recipient, but users live on several
--       hosts (main, guest, auth for Jicofo) and would each need a hook.
--   room:route_stanza() is the one per-recipient choke point inside the room, for every host.
--   It is a room_mt method, so we shadow it on each room instance (muc-room-created), clone
--   the stanza (it is shared), and pass the copy to the previous route_stanza.
--
-- Signing: HS256 with Jitsi's bundled luajwtjitsi (module:require "luajwtjitsi", as
-- mod_short_lived_token and token/util.lib.lua do). If it cannot be loaded, the module falls
-- back to Prosody's util.hashes.hmac_sha256 + util.json + base64 (encode_hs256 below).
--
-- Tokens: one per recipient XMPP session (full JID) and role, re-minted when half its
-- lifetime has passed or the role changes. Jitsi sends presence on every mute or name change;
-- a fresh value each time would churn the document URL. A reload or rejoin is a new session,
-- so it gets a new jti. The token and the secrets are never logged.
--
-- Options (MUC component; XMPP_MUC_CONFIGURATION in docker-jitsi-meet):
--   opencanvas_url           = "https://canvas.example.com"  required
--   opencanvas_secret        = "<hex>"                        required, the host's jwt_secret
--   opencanvas_host_id       = "jitsi"                        the hosts.toml id (JWT iss)
--   opencanvas_api_key       = "<hex>"                        enables the room-end DELETE
--   opencanvas_guest_role    = "edit"                         edit | comment | view
--   opencanvas_token_ttl     = 3600                           seconds, 60..36000
--   opencanvas_enabled_rooms = "all"                          or a Lua pattern on the room name

local M = {}

M.ROLES = { edit = true, comment = true, view = true }
M.MAX_TTL = 36000

function M.clamp_ttl(ttl)
    ttl = math.floor(tonumber(ttl) or 3600)
    if ttl < 60 then return 60 end
    if ttl > M.MAX_TTL then return M.MAX_TTL end
    return ttl
end

-- "all" (or empty) enables every room; anything else is a Lua pattern matched against the
-- room name (the node of the room JID). Jicofo's health-check rooms are always skipped.
function M.room_enabled(room_name, pattern)
    if not room_name or room_name:sub(1, 21) == "__jicofo-health-check" then return false end
    if pattern == nil or pattern == "" or pattern == "all" then return true end
    local ok, found = pcall(string.find, room_name, pattern)
    return ok and found ~= nil
end

-- Stable per meeting: the room JID carries the tenant (room@conference.tenant.example).
function M.file_id(room_jid, meeting_id, sha256_hex)
    return "jitsi-" .. sha256_hex(room_jid .. "\0" .. (meeting_id or "")):sub(1, 40)
end

function M.role_for(occupant_role, affiliation, guest_role)
    if occupant_role == "moderator" or affiliation == "owner" then return "edit" end
    return M.ROLES[guest_role] and guest_role or "view"
end

local function http_url(s)
    return type(s) == "string" and (s:match("^https?://") ~= nil) and s or nil
end

-- docs/05 §3 claim shape. `user` = { id, name, avatar? }.
function M.build_claims(a)
    local avatar = http_url(a.user.avatar)
    return {
        iss = a.host_id,
        aud = "opencanvas",
        iat = a.now,
        exp = a.now + M.clamp_ttl(a.ttl),
        jti = a.jti,
        file = { id = a.file_id, name = a.file_name },
        user = { id = a.user.id, name = a.user.name, avatar = avatar },
        role = a.role,
        callbackToken = a.file_id,
    }
end

-- Fallback signer. prim = { json_encode, hmac_sha256 (raw bytes), base64_encode }.
function M.encode_hs256(claims, secret, prim)
    local function b64url(s)
        return (prim.base64_encode(s):gsub("%+", "-"):gsub("/", "_"):gsub("=", ""))
    end
    local input = b64url(prim.json_encode({ alg = "HS256", typ = "JWT" })) .. "." ..
        b64url(prim.json_encode(claims))
    return input .. "." .. b64url(prim.hmac_sha256(secret, input))
end

function M.launch_url(base, token)
    return base .. "/v1/launch?token=" .. token
end

-- Outside Prosody (unit tests) only the pure functions above are loaded.
if type(module) ~= "table" or type(module.get_option_string) ~= "function" then
    return M
end

-------------------------------------------------------------------------------------------
-- Prosody part
-------------------------------------------------------------------------------------------

local st = require "util.stanza"
local jid_split = require "util.jid".split
local jid_bare = require "util.jid".bare
local hashes = require "util.hashes"
local uuid = require "util.uuid".generate
local http = require "net.http"

local base_url = module:get_option_string("opencanvas_url", ""):gsub("/+$", "")
local secret = module:get_option_string("opencanvas_secret", "")
local host_id = module:get_option_string("opencanvas_host_id", "jitsi")
local api_key = module:get_option_string("opencanvas_api_key", "")
local guest_role = module:get_option_string("opencanvas_guest_role", "edit")
local token_ttl = M.clamp_ttl(module:get_option_number("opencanvas_token_ttl", 3600))
local enabled_rooms = module:get_option_string("opencanvas_enabled_rooms", "all")

if not http_url(base_url) or secret == "" then
    module:log("error", "opencanvas_url and opencanvas_secret are required; module inactive")
    return
end
if not M.ROLES[guest_role] then
    module:log("error", "opencanvas_guest_role must be edit, comment or view; using view")
    guest_role = "view"
end

local function sha256_hex(s) return hashes.sha256(s, true) end

local sign
do
    local ok, jwt = pcall(module.require, module, "luajwtjitsi")
    if ok and jwt and jwt.encode then
        sign = function(claims) return jwt.encode(claims, secret, "HS256") end
        module:log("info", "signing launch tokens with luajwtjitsi (HS256)")
    else
        local json = require "util.json"
        local base64 = require "util.encodings".base64
        local prim = {
            json_encode = json.encode,
            hmac_sha256 = function(k, d) return hashes.hmac_sha256(k, d) end,
            base64_encode = base64.encode,
        }
        sign = function(claims) return M.encode_hs256(claims, secret, prim) end
        module:log("info", "luajwtjitsi not found; signing with util.hashes (HS256)")
    end
end

-- room.jid -> { [recipient full jid] = { token, role, refresh_at } }
local cache = {}

local function room_file_id(room)
    local id = room._data.opencanvas_file_id
    if not id then
        id = M.file_id(room.jid, room._data.meetingId, sha256_hex)
        room._data.opencanvas_file_id = id
    end
    return id
end

local function nick_of(occupant)
    local pr = occupant:get_presence()
    local nick = pr and pr:get_child_text("nick", "http://jabber.org/protocol/nick")
    if nick and nick:match("%S") then return nick end
    return nil
end

local function user_of(occupant, full_jid)
    local session = prosody.full_sessions[full_jid]
    local ctx = session and session.jitsi_meet_context_user
    local id = ctx and ctx.id and tostring(ctx.id) ~= "" and tostring(ctx.id)
    return {
        -- Anonymous users have no stable id; a hash of the (random) bare JID keeps it opaque.
        id = id or ("guest-" .. sha256_hex(occupant.bare_jid):sub(1, 16)),
        name = (ctx and type(ctx.name) == "string" and ctx.name ~= "" and ctx.name)
            or nick_of(occupant) or "Guest",
        avatar = ctx and ctx.avatar,
    }
end

local function token_for(room, occupant, full_jid)
    local role = M.role_for(occupant.role, room:get_affiliation(occupant.bare_jid), guest_role)
    local per_room = cache[room.jid]
    if not per_room then per_room = {}; cache[room.jid] = per_room end
    local now = os.time()
    local hit = per_room[full_jid]
    if hit and hit.role == role and now < hit.refresh_at then return hit.token end

    local room_name = jid_split(room.jid)
    local token, err = sign(M.build_claims {
        host_id = host_id, now = now, ttl = token_ttl, jti = uuid(),
        file_id = room_file_id(room), file_name = room_name,
        user = user_of(occupant, full_jid), role = role,
    })
    if not token then
        module:log("error", "could not sign an OpenCanvas token for %s: %s", room.jid, tostring(err))
        return nil
    end
    per_room[full_jid] = { token = token, role = role, refresh_at = now + math.floor(token_ttl / 2) }
    return token
end

local function strip_etherpad(stanza)
    return stanza:maptags(function(tag)
        if tag.name == "etherpad" then return nil end
        return tag
    end)
end

local function is_service(bare)
    local node = jid_split(bare)
    return node == "focus"
end

local function wrap_room(room)
    if room._opencanvas_route then return end
    if not M.room_enabled(jid_split(room.jid), enabled_rooms) then return end
    local own = rawget(room, "route_stanza") -- nil unless another module shadowed it already
    local previous = room.route_stanza
    room._opencanvas_own = own
    room._opencanvas_route = function(self, stanza)
        if stanza.name ~= "presence" then return previous(self, stanza) end
        -- The same object goes to every recipient (route_to_occupant): never mutate it.
        local out = strip_etherpad(st.clone(stanza))
        local to = out.attr.to
        if out.attr.type ~= "unavailable" and to and not is_service(jid_bare(to)) then
            local recipient = self:get_occupant_by_real_jid(to)
            local token = recipient and token_for(self, recipient, to)
            if token then
                out:reset():tag("etherpad"):text(M.launch_url(base_url, token)):up()
            end
        end
        return previous(self, out)
    end
    room.route_stanza = room._opencanvas_route
end

local function unwrap_room(room)
    if room._opencanvas_route and rawget(room, "route_stanza") == room._opencanvas_route then
        room.route_stanza = room._opencanvas_own
    end
    room._opencanvas_route, room._opencanvas_own = nil, nil
end

local function end_session(room)
    cache[room.jid] = nil
    local file_id = room._data.opencanvas_file_id
    if not file_id or api_key == "" then return end
    local url = base_url .. "/v1/files/" .. file_id .. "/session"
    http.request(url, {
        method = "DELETE",
        headers = { ["X-OpenCanvas-Host"] = host_id, ["X-OpenCanvas-Key"] = api_key },
    }, function(_, code)
        if type(code) == "number" and code >= 200 and code < 300 or code == 404 then
            module:log("info", "OpenCanvas session for %s ended (%s)", room.jid, tostring(code))
        else
            module:log("warn", "OpenCanvas session end for %s failed (%s); idle timeout will end it",
                room.jid, tostring(code))
        end
    end)
end

module:hook("muc-room-created", function(event) wrap_room(event.room) end, -1)

module:hook("muc-occupant-left", function(event)
    local per_room = cache[event.room.jid]
    local from = event.stanza and event.stanza.attr.from
    if per_room and from then per_room[from] = nil end
end)

module:hook("muc-room-destroyed", function(event) end_session(event.room) end)

-- Rooms that already exist when the module is (re)loaded.
local function live_rooms()
    local muc = prosody.hosts[module.host] and prosody.hosts[module.host].modules.muc
    if muc and muc.live_rooms then return muc.live_rooms() end
    if muc and muc.each_room then return muc.each_room(true) end
    return function() return nil end
end

function module.load()
    for room in live_rooms() do wrap_room(room) end
end

function module.unload()
    for room in live_rooms() do unwrap_room(room) end
end
