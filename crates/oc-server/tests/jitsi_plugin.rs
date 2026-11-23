// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! JIT-02: a launch token minted by the Jitsi Prosody plugin (integrations/jitsi) passes
//! OpenCanvas's own verifier. Runs `integrations/jitsi/test/mint_test.lua` with a Lua 5.3+
//! interpreter (`$OC_LUA`, else `lua`, `lua5.4`, `lua5.3`); skipped when none is installed.

use std::path::PathBuf;
use std::process::Command;

use oc_server::grant::Role;
use oc_server::hosts::Hosts;

const SECRET: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

fn mint(now: i64) -> Option<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = root.join("integrations/jitsi/test/mint_test.lua");
    let candidates: Vec<String> = std::env::var("OC_LUA")
        .map(|v| vec![v])
        .unwrap_or_else(|_| vec!["lua".into(), "lua5.4".into(), "lua5.3".into()]);
    for lua in candidates {
        let Ok(out) = Command::new(&lua)
            .arg(&script)
            .arg(SECRET)
            .arg(now.to_string())
            .output()
        else {
            continue;
        };
        assert!(
            out.status.success(),
            "{lua} mint_test.lua failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let stdout = String::from_utf8(out.stdout).unwrap();
        return Some(stdout.lines().last().unwrap().trim().to_string());
    }
    None
}

#[test]
fn plugin_token_passes_the_opencanvas_verifier() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let Some(token) = mint(now) else {
        eprintln!("SKIPPED: no Lua 5.3+ interpreter (set OC_LUA or install lua)");
        return;
    };
    let hosts = Hosts::parse(
        &format!(
            r#"
            [[host]]
            id = "acme-jitsi"
            name = "Acme Meet"
            jwt_secret = "{SECRET}"
            callback_base = "https://meet.acme.example/unused"
            allowed_origins = ["https://meet.acme.example"]
            "#
        ),
        None,
    )
    .unwrap();

    let (host, claims) =
        oc_server::jwt::verify(&token, &hosts, now).expect("plugin token verifies");
    assert_eq!(host.id, "acme-jitsi");
    assert_eq!(claims.exp - now, 36000, "TTL capped at 10 h");
    let grant = claims.into_grant();
    assert_eq!(grant.role, Role::Edit);
    assert!(grant.file.id.starts_with("jitsi-"));
    assert_eq!(grant.file.name, "standup");
    assert_eq!(grant.user.id, "u-42");
    assert_eq!(grant.user.name, "Asha Rao");
    assert_eq!(grant.user.avatar, None);

    // A different secret must not verify the same token.
    let wrong = Hosts::parse(
        r#"
        [[host]]
        id = "acme-jitsi"
        name = "Acme Meet"
        jwt_secret = "not-the-secret"
        callback_base = "https://meet.acme.example/unused"
        allowed_origins = ["https://meet.acme.example"]
        "#,
        None,
    )
    .unwrap();
    assert!(oc_server::jwt::verify(&token, &wrong, now).is_err());
}
