-- SPDX-License-Identifier: Apache-2.0
-- Copyright 2026 CasualOffice
--
-- Unit test for mod_opencanvas's token minting (Lua 5.3+; no Prosody, no C modules).
--   lua integrations/jitsi/test/mint_test.lua [secret] [now]
-- Asserts the claim shape, then prints one HS256 token on the last line, which
-- crates/oc-server/tests/jitsi_plugin.rs verifies with OpenCanvas's own verifier.

local dir = (arg and arg[0] or ""):match("^(.*)/test/[^/]*$") or "integrations/jitsi"
local M = dofile(dir .. "/mod_opencanvas.lua")

-- Pure-Lua SHA-256 / HMAC / base64 / JSON: test fixtures only (Prosody supplies real ones).
local K = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local function rrot(x, n) return ((x >> n) | (x << (32 - n))) & 0xffffffff end
local function sha256(msg)
    local h = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 }
    local len = #msg
    msg = msg .. "\128" .. string.rep("\0", (55 - len) % 64) .. string.pack(">I8", len * 8)
    for chunk = 1, #msg, 64 do
        local w = {}
        for i = 0, 15 do w[i] = string.unpack(">I4", msg, chunk + i * 4) end
        for i = 16, 63 do
            local s0 = rrot(w[i - 15], 7) ~ rrot(w[i - 15], 18) ~ (w[i - 15] >> 3)
            local s1 = rrot(w[i - 2], 17) ~ rrot(w[i - 2], 19) ~ (w[i - 2] >> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffff
        end
        local a, b, c, d, e, f, g, hh = table.unpack(h)
        for i = 0, 63 do
            local S1 = rrot(e, 6) ~ rrot(e, 11) ~ rrot(e, 25)
            local ch = (e & f) ~ (~e & g)
            local t1 = (hh + S1 + ch + K[i + 1] + w[i]) & 0xffffffff
            local S0 = rrot(a, 2) ~ rrot(a, 13) ~ rrot(a, 22)
            local maj = (a & b) ~ (a & c) ~ (b & c)
            local t2 = (S0 + maj) & 0xffffffff
            hh, g, f, e, d, c, b, a = g, f, e, (d + t1) & 0xffffffff, c, b, a, (t1 + t2) & 0xffffffff
        end
        for i, v in ipairs({ a, b, c, d, e, f, g, hh }) do h[i] = (h[i] + v) & 0xffffffff end
    end
    return string.pack(">I4I4I4I4I4I4I4I4", table.unpack(h))
end
local function hex(s) return (s:gsub(".", function(c) return string.format("%02x", c:byte()) end)) end
local function hmac_sha256(key, data)
    if #key > 64 then key = sha256(key) end
    key = key .. string.rep("\0", 64 - #key)
    local function xor(pad) return (key:gsub(".", function(c) return string.char(c:byte() ~ pad) end)) end
    return sha256(xor(0x5c) .. sha256(xor(0x36) .. data))
end
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
local function base64(s)
    return (s:gsub(".?.?.?", function(t)
        if t == "" then return "" end
        local n = #t
        local v = string.unpack(">I3", t .. string.rep("\0", 3 - n))
        local out = {}
        for i = 1, 4 do
            out[i] = i <= n + 1 and B64:sub(((v >> (24 - 6 * i)) & 63) + 1, ((v >> (24 - 6 * i)) & 63) + 1) or "="
        end
        return table.concat(out)
    end))
end
local function json(v)
    local t = type(v)
    if t == "string" then
        return '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
    elseif t == "number" then
        return math.type(v) == "integer" and tostring(v) or string.format("%.17g", v)
    elseif t == "boolean" then
        return tostring(v)
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = json(k) .. ":" .. json(v[k]) end
    return "{" .. table.concat(parts, ",") .. "}"
end

-- Fixture self-checks (FIPS 180-2 and RFC 4231 test case 2).
assert(hex(sha256("abc")) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
assert(hex(hmac_sha256("Jefe", "what do ya want for nothing?"))
    == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
assert(base64("any carnal pleas") == "YW55IGNhcm5hbCBwbGVhcw==")

local passed = 0
local function check(name, ok)
    if not ok then error("FAIL: " .. name, 2) end
    passed = passed + 1
end

-- Pure helpers.
check("ttl clamps high", M.clamp_ttl(99999) == 36000)
check("ttl clamps low", M.clamp_ttl(5) == 60)
check("ttl default", M.clamp_ttl(nil) == 3600)
check("all rooms", M.room_enabled("standup", "all"))
check("pattern match", M.room_enabled("canvas-standup", "^canvas%-"))
check("pattern miss", not M.room_enabled("standup", "^canvas%-"))
check("bad pattern is off", not M.room_enabled("standup", "["))
check("health check skipped", not M.room_enabled("__jicofo-health-check-123", "all"))
check("moderator edits", M.role_for("moderator", "member", "view") == "edit")
check("owner edits", M.role_for("participant", "owner", "view") == "edit")
check("guest role", M.role_for("participant", "member", "comment") == "comment")
check("bad guest role is view", M.role_for("participant", "none", "admin") == "view")

local function sha_hex(s) return hex(sha256(s)) end
local a = M.file_id("standup@conference.acme.meet.jitsi", "m-1", sha_hex)
local b = M.file_id("standup@conference.acme.meet.jitsi", "m-2", sha_hex)
local c = M.file_id("standup@conference.other.meet.jitsi", "m-1", sha_hex)
check("file id shape", a:match("^jitsi%-%x+$") and #a == 46)
check("new meeting, new canvas", a ~= b)
check("tenant in file id", a ~= c)
check("file id stable", a == M.file_id("standup@conference.acme.meet.jitsi", "m-1", sha_hex))

-- Claims.
local secret = arg and arg[1] or "0123456789abcdef0123456789abcdef"
local now = tonumber(arg and arg[2]) or os.time()
local claims = M.build_claims {
    host_id = "acme-jitsi", now = now, ttl = 999999, jti = "jti-" .. now,
    file_id = a, file_name = "standup",
    user = { id = "u-42", name = "Asha Rao", avatar = "javascript:alert(1)" },
    role = "edit",
}
check("iss", claims.iss == "acme-jitsi")
check("aud", claims.aud == "opencanvas")
check("exp capped at 10 h", claims.exp - now == 36000)
check("jti", claims.jti == "jti-" .. now)
check("file", claims.file.id == a and claims.file.name == "standup")
check("user", claims.user.id == "u-42" and claims.user.name == "Asha Rao")
check("non-http avatar dropped", claims.user.avatar == nil)
check("role", claims.role == "edit")
check("callbackToken", type(claims.callbackToken) == "string")
check("launch url", M.launch_url("https://canvas.example.com", "x.y.z")
    == "https://canvas.example.com/v1/launch?token=x.y.z&ep=")

local token = M.encode_hs256(claims, secret,
    { json_encode = json, hmac_sha256 = hmac_sha256, base64_encode = base64 })
check("three url-safe parts", token:match("^[%w_%-]+%.[%w_%-]+%.[%w_%-]+$") ~= nil)

io.stderr:write(("mint_test: %d checks passed (%s)\n"):format(passed, _VERSION))
print(token)
