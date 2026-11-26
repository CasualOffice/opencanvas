// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `oc-bench scenario`: one benchmark scenario file (`bench/scenarios/*.toml`, docs/36 §3.2),
//! run end to end against a release server this process starts and owns.
//!
//!   oc-bench scenario bench/scenarios/x10k.toml --bin target/release/opencanvas \
//!       [--size quick|full] [--connections N --rooms N --minutes M --fault-at-min M] \
//!       [--machine local] [--results-dir bench/results] [--port 8701 --host-port 8702]
//!
//! The scenario states its load mix: idle viewers (receive only), presence-only peers (cursor
//! moves at `presence_hz`) and typists (`typing_hz` edits a second, no pauses). Rooms cycle
//! through the seed documents by weight. Clients ramp in at `connect_rate`; after the ramp, every
//! `bucket_secs` a row records edit latency (an editor's frame sent → seen by a probe peer:
//! p50/p95/p99/max), the server's CPU and RSS, frames, errors, drops and reconnects. Faults
//! (`kill-restart`) `kill -9` the server at a minute and start it again on the same database;
//! clients reconnect with backoff and the time from drop to ready again is recorded.
//!
//! The result (`<results-dir>/<date>-<scenario>-<machine>.json`) carries the commit, the scenario
//! file's hash, the hardware, the store, the load mix as run (with role counts) and every pass
//! rule with its verdict; a rule this runner cannot measure is listed under `notMeasured`.

use std::collections::BTreeMap;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::client::{Counters, RunCfg, Shared, Spec, run_user};
use crate::{Args, docs, mockhost, pct, sample};

#[derive(Deserialize, Clone)]
pub struct Scenario {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Run by `scripts/bench.sh <legacy>` instead (docs/22 scenarios, unchanged).
    #[serde(default)]
    pub legacy: Option<String>,
    #[serde(default)]
    pub machine: Option<toml::Value>,
    pub load: Load,
    pub mix: Mix,
    pub run: RunS,
    #[serde(default)]
    pub faults: Vec<Fault>,
    #[serde(default)]
    pub pass: Pass,
    #[serde(default)]
    pub server_env: BTreeMap<String, String>,
    #[serde(default)]
    pub size: BTreeMap<String, Over>,
    #[serde(default)]
    pub not_measured: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub struct Load {
    pub connections: usize,
    pub rooms: usize,
    #[serde(default = "d_docs")]
    pub docs: String,
    #[serde(default = "d_rate")]
    pub connect_rate: f64,
    #[serde(default = "d_probes")]
    pub probes_per_room: usize,
    #[serde(default)]
    pub source_addrs: Vec<String>,
}
fn d_docs() -> String {
    "demo".into()
}
fn d_rate() -> f64 {
    250.0
}
fn d_probes() -> usize {
    2
}

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct Mix {
    pub idle: f64,
    pub presence: f64,
    pub typing: f64,
    #[serde(default)]
    pub presence_hz: f64,
    #[serde(default = "d_one")]
    pub typing_hz: f64,
}
fn d_one() -> f64 {
    1.0
}

#[derive(Deserialize, Clone)]
pub struct RunS {
    pub minutes: f64,
    #[serde(default = "d_bucket")]
    pub bucket_secs: u64,
}
fn d_bucket() -> u64 {
    60
}

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct Fault {
    pub kind: String,
    pub at_min: f64,
}

#[derive(Deserialize, Clone, Default, serde::Serialize)]
pub struct Pass {
    pub p99_ms: Option<f64>,
    #[serde(default)]
    pub p99_grace_secs: u64,
    pub rss_mb: Option<f64>,
    pub reconnect_secs: Option<f64>,
    pub rss_drift_pct: Option<f64>,
    /// After a fault, a bucket's p99 is back within 1.5× the pre-fault p99 within this many s.
    pub recover_secs: Option<f64>,
    #[serde(default)]
    pub no_drops: bool,
}

#[derive(Deserialize, Clone, Default, serde::Serialize)]
pub struct Over {
    pub connections: Option<usize>,
    pub rooms: Option<usize>,
    pub minutes: Option<f64>,
    pub bucket_secs: Option<u64>,
    pub fault_at_min: Option<f64>,
}

impl Scenario {
    fn apply(&mut self, o: &Over) {
        if let Some(v) = o.connections {
            self.load.connections = v;
        }
        if let Some(v) = o.rooms {
            self.load.rooms = v;
        }
        if let Some(v) = o.minutes {
            self.run.minutes = v;
        }
        if let Some(v) = o.bucket_secs {
            self.run.bucket_secs = v;
        }
        if let Some(v) = o.fault_at_min {
            for f in &mut self.faults {
                f.at_min = v;
            }
        }
    }
}

fn sh_out(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// CPU model, vCPU, RAM, OS, kernel and storage of this machine.
pub fn hardware() -> Value {
    if cfg!(target_os = "macos") {
        let disk = sh_out("diskutil", &["info", "/"]);
        let field = |k: &str| {
            disk.lines()
                .find(|l| l.trim_start().starts_with(k))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default()
        };
        json!({
            "cpu": sh_out("sysctl", &["-n", "machdep.cpu.brand_string"]),
            "vcpu": sh_out("sysctl", &["-n", "hw.ncpu"]).parse::<u64>().unwrap_or(0),
            "ramGb": sh_out("sysctl", &["-n", "hw.memsize"]).parse::<u64>().unwrap_or(0) / (1 << 30),
            "os": format!("{} {}", sh_out("sw_vers", &["-productName"]), sh_out("sw_vers", &["-productVersion"])),
            "kernel": sh_out("uname", &["-sr"]),
            "storage": format!("{} {} ({})", field("Device Location"), if field("Solid State") == "Yes" { "SSD" } else { "disk" }, field("Protocol")),
        })
    } else {
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
        let mem = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let kb: u64 = mem
            .lines()
            .find(|l| l.starts_with("MemTotal"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        json!({
            "cpu": cpuinfo.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split_once(':')).map(|(_, v)| v.trim()).unwrap_or(""),
            "vcpu": sh_out("nproc", &[]).parse::<u64>().unwrap_or(0),
            "ramGb": kb / (1 << 20),
            "os": sh_out("sh", &["-c", ". /etc/os-release && echo $PRETTY_NAME"]),
            "kernel": sh_out("uname", &["-sr"]),
            "storage": sh_out("sh", &["-c", "lsblk -d -n -o NAME,ROTA,MODEL | head -3 | tr '\\n' ';'"]),
        })
    }
}

/// 1-minute load average of the machine (other processes included).
fn loadavg() -> Value {
    let s = if cfg!(target_os = "macos") {
        sh_out("sysctl", &["-n", "vm.loadavg"])
    } else {
        std::fs::read_to_string("/proc/loadavg").unwrap_or_default()
    };
    s.trim_matches(|c: char| c == '{' || c == '}' || c.is_whitespace())
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map_or(Value::Null, |v| json!(v))
}

/// Role of the k-th peer of a room: a low-discrepancy spread (golden ratio) so every room of
/// any size gets the stated shares. 0 idle, 1 presence, 2 typing.
fn role(k: usize, mix: &Mix) -> u8 {
    let u = (k as f64 * 0.618_033_988_749_895).fract();
    if u < mix.typing {
        2
    } else if u < mix.typing + mix.presence {
        1
    } else {
        0
    }
}

struct Server {
    bin: String,
    env: Vec<(String, String)>,
    port: u16,
    log: String,
    child: Option<Child>,
    pid: Arc<AtomicU32>,
}

impl Server {
    async fn start(&mut self, http: &reqwest::Client) -> anyhow::Result<Duration> {
        let t = Instant::now();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)?;
        let child = Command::new(&self.bin)
            .env_remove("OC_DEV")
            .envs(self.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .spawn()?;
        self.pid.store(child.id(), Ordering::Relaxed);
        self.child = Some(child);
        let url = format!("http://127.0.0.1:{}/readyz", self.port);
        while t.elapsed() < Duration::from_secs(60) {
            if http
                .get(&url)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
            {
                return Ok(t.elapsed());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        anyhow::bail!("server did not become ready; see {}", self.log)
    }

    fn kill9(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill(); // SIGKILL
            let _ = c.wait();
        }
    }

    fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = Command::new("kill").arg(c.id().to_string()).status();
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(20) {
                if c.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

pub async fn run(file: &str, a: Args) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(file)?;
    let mut sc: Scenario = toml::from_str(&text)?;
    if let Some(l) = &sc.legacy {
        anyhow::bail!(
            "{} is a docs/22 scenario: run `scripts/bench.sh {l}` (scripts/bench/run does)",
            sc.name
        );
    }
    let size = a.s("size", "quick");
    if let Some(o) = sc.size.get(&size).cloned() {
        sc.apply(&o);
    } else if size != "full" {
        anyhow::bail!("{}: no [size.{size}] in {file}", sc.name);
    }
    // Command-line overrides (a local short run): recorded in the result.
    let cli = Over {
        connections: a.0.get("connections").and_then(|v| v.parse().ok()),
        rooms: a.0.get("rooms").and_then(|v| v.parse().ok()),
        minutes: a.0.get("minutes").and_then(|v| v.parse().ok()),
        bucket_secs: a.0.get("bucket-secs").and_then(|v| v.parse().ok()),
        fault_at_min: a.0.get("fault-at-min").and_then(|v| v.parse().ok()),
    };
    sc.apply(&cli);
    let bin = a.s("bin", "target/release/opencanvas");
    let port: u16 = a.n("port", 8701);
    let host_port: u16 = a.n("host-port", 8702);
    let machine = a.s("machine", "local");
    let work = a.s(
        "work",
        &std::env::temp_dir()
            .join(format!("oc-bench-{}", std::process::id()))
            .to_string_lossy(),
    );
    std::fs::create_dir_all(&work)?;
    let secret = "bench-secret-0123456789abcdef0123456789";
    std::fs::write(
        format!("{work}/hosts.toml"),
        format!(
            "[[host]]\nid = \"bench\"\nname = \"Bench host\"\nmode = \"jwt\"\njwt_alg = \"HS256\"\njwt_secret = \"{secret}\"\napi_key = \"bench-api-key\"\ncallback_base = \"http://127.0.0.1:{host_port}/api\"\n"
        ),
    )?;
    let db_url = a.s(
        "database-url",
        &format!("sqlite://{work}/bench.db?mode=rwc"),
    );
    let store = if db_url.starts_with("sqlite") {
        "sqlite".to_string()
    } else {
        db_url.split(':').next().unwrap_or("db").to_string()
    };
    let kek = sh_out("openssl", &["rand", "-base64", "32"]);
    let mut env: Vec<(String, String)> = vec![
        ("DATABASE_URL".into(), db_url),
        ("OC_KEK".into(), kek),
        ("OC_HOSTS_FILE".into(), format!("{work}/hosts.toml")),
        ("OC_BIND".into(), format!("127.0.0.1:{port}")),
        ("OC_PUBLIC_URL".into(), format!("http://127.0.0.1:{port}")),
        (
            "OC_LOG".into(),
            std::env::var("OC_LOG").unwrap_or_else(|_| "warn".into()),
        ),
    ];
    env.extend(sc.server_env.clone());
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(256)
        .timeout(Duration::from_secs(30))
        .build()?;
    let pid = Arc::new(AtomicU32::new(0));
    let mut server = Server {
        bin,
        env,
        port,
        log: format!("{work}/server.log"),
        child: None,
        pid: pid.clone(),
    };
    let host_stats = Arc::new(mockhost::HostStats::default());
    mockhost::serve(host_port, host_stats.clone()).await?;
    let boot = server.start(&http).await?;
    // Other work on the machine skews a local run: its load average is part of the result.
    let load_start = loadavg();
    let base = format!("http://127.0.0.1:{port}");
    let run_id = format!(
        "{}{}",
        sc.name
            .to_lowercase()
            .replace(|c: char| !c.is_ascii_alphanumeric(), ""),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
            % 100_000
    );
    let sh = Arc::new(Shared {
        http: http.clone(),
        cfg: RunCfg {
            http_base: vec![base.clone()],
            ws_base: vec![base.replacen("http://", "ws://", 1)],
            sticky: true,
            secret: secret.into(),
            host_id: "bench".into(),
            run_id,
            docs: docs::parse_mix(&sc.load.docs)?,
            reconnect: true,
            source_addrs: crate::source_addrs(&sc.load.source_addrs.join(","))?,
            cps: (sc.mix.typing_hz, sc.mix.typing_hz),
            active: 1.0,
        },
        host: host_stats.clone(),
        sent: Default::default(),
        lat_us: Default::default(),
        connect_ms: Default::default(),
        c: Counters::default(),
        closes: Default::default(),
        errors: Default::default(),
        quiet: false.into(),
        reconnect_ms: Default::default(),
        stopping: false.into(),
    });

    let (n, rooms) = (sc.load.connections, sc.load.rooms.max(1));
    let mut roles = [0usize; 3];
    let specs: Vec<Spec> = (0..n)
        .map(|i| {
            let (room, k) = (i % rooms, i / rooms);
            let r = role(k, &sc.mix);
            roles[r as usize] += 1;
            Spec {
                idx: i,
                room,
                editor: r == 2,
                probe: k < sc.load.probes_per_room,
                presence_hz: if r == 1 { sc.mix.presence_hz } else { 0.0 },
            }
        })
        .collect();
    println!(
        "# {} ({size}): {n} connections over {rooms} rooms, docs {}, mix idle/presence/typing {}/{}/{} (presence {} Hz, typing {} edits/s), {} min, buckets {} s, server ready in {} ms",
        sc.name,
        sc.load.docs,
        roles[0],
        roles[1],
        roles[2],
        sc.mix.presence_hz,
        sc.mix.typing_hz,
        sc.run.minutes,
        sc.run.bucket_secs,
        boot.as_millis()
    );

    // 5 s timeline of the server process (pid follows restarts).
    let timeline: Arc<Mutex<Vec<Value>>> = Arc::default();
    let t_start = Instant::now();
    {
        let (tl, pid, sh) = (timeline.clone(), pid.clone(), sh.clone());
        tokio::spawn(async move {
            let mut prev: Option<(Instant, u32, f64)> = None;
            loop {
                let p = pid.load(Ordering::Relaxed);
                let s = tokio::task::spawn_blocking(move || sample(&[p]))
                    .await
                    .unwrap_or_default();
                let now = Instant::now();
                let cpu = match prev {
                    Some((t, q, c)) if q == p => {
                        (s.cpu - c) / now.duration_since(t).as_secs_f64() * 100.0
                    }
                    _ => 0.0,
                };
                prev = Some((now, p, s.cpu));
                tl.lock().expect("lock").push(json!({
                    "t": t_start.elapsed().as_secs(), "cpuPct": cpu.round(), "rssMb": s.rss_kb / 1024,
                    "live": sh.c.live.load(Ordering::Relaxed),
                }));
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    // Ramp.
    let gate = Arc::new(tokio::sync::Semaphore::new(256));
    let gap = Duration::from_secs_f64(1.0 / sc.load.connect_rate.max(1.0));
    for spec in specs {
        let (sh2, permit) = (sh.clone(), gate.clone().acquire_owned().await?);
        let idx = spec.idx as u64;
        tokio::spawn(async move {
            let sh3 = sh2.clone();
            let watch = tokio::spawn(async move {
                let t = Instant::now();
                while t.elapsed() < Duration::from_secs(30) {
                    let c = &sh3.c;
                    if c.ready.load(Ordering::Relaxed)
                        + c.launch_err.load(Ordering::Relaxed)
                        + c.ws_err.load(Ordering::Relaxed)
                        > idx
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                drop(permit);
            });
            run_user(sh2, spec).await;
            watch.abort();
        });
        tokio::time::sleep(gap).await;
    }
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(120) {
        let c = &sh.c;
        if c.ready.load(Ordering::Relaxed) + c.launch_err.load(Ordering::Relaxed) >= n as u64 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let ramp_secs = t_start.elapsed().as_secs_f64();
    let mut con = std::mem::take(&mut *sh.connect_ms.lock().expect("lock"));
    con.sort_unstable();
    let ready_after_ramp = sh.c.ready.load(Ordering::Relaxed);
    println!(
        "ramp: {ready_after_ramp}/{n} ready in {ramp_secs:.1} s (connect p50 {} p95 {} ms), live {}",
        pct(&con, 0.5),
        pct(&con, 0.95),
        sh.c.live.load(Ordering::Relaxed)
    );

    // Measured window, in buckets; faults at their minute (from the end of the ramp).
    sh.lat_us.lock().expect("lock").clear();
    let total = Duration::from_secs_f64(sc.run.minutes * 60.0);
    let bucket = Duration::from_secs(sc.run.bucket_secs.max(1));
    let mut faults: Vec<(Duration, Fault)> = sc
        .faults
        .iter()
        .map(|f| (Duration::from_secs_f64(f.at_min * 60.0), f.clone()))
        .collect();
    faults.sort_by_key(|f| f.0);
    let mut fault_log = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let t_run = Instant::now();
    let l = |x: &std::sync::atomic::AtomicU64| x.load(Ordering::Relaxed);
    let me = std::process::id();
    let mut prev = (
        Instant::now(),
        sample(&[pid.load(Ordering::Relaxed)]),
        sample(&[me]),
        [
            l(&sh.c.frames_in),
            l(&sh.c.updates_out),
            l(&sh.c.awareness_out),
            l(&sh.c.dropped),
            l(&sh.c.reconnects),
            l(&sh.c.ws_err) + l(&sh.c.launch_err),
            l(&sh.c.refused),
        ],
        pid.load(Ordering::Relaxed),
    );
    println!(
        "| t s | live | p50 ms | p95 ms | p99 ms | max ms | samples | srv CPU % | RSS MB | loadgen CPU % | frames in/s | upd out/s | aw out/s | drops | reconn | err | refused | fault |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut next = bucket;
    let mut faulted_in_bucket: Option<String> = None;
    while t_run.elapsed() < total {
        let until = next.min(total);
        // A fault due before the end of this bucket runs on time.
        if let Some((at, _)) = faults.first()
            && *at < until
        {
            tokio::time::sleep(at.saturating_sub(t_run.elapsed())).await;
            let (_, f) = faults.remove(0);
            let t_kill = t_run.elapsed().as_secs_f64();
            let live_before = sh.c.live.load(Ordering::Relaxed);
            server.kill9();
            let ready = server.start(&http).await?;
            println!(
                "fault: {} at {:.0} s (live before {live_before}); server ready again in {} ms",
                f.kind,
                t_kill,
                ready.as_millis()
            );
            fault_log.push(json!({"kind": f.kind, "atSecs": t_kill, "liveBefore": live_before, "serverReadyMs": ready.as_millis() as u64}));
            faulted_in_bucket = Some(f.kind);
            continue;
        }
        tokio::time::sleep(until.saturating_sub(t_run.elapsed())).await;
        next = until + bucket;
        let mut lat = std::mem::take(&mut *sh.lat_us.lock().expect("lock"));
        lat.sort_unstable();
        let p = pid.load(Ordering::Relaxed);
        let (srv, mine) = tokio::task::spawn_blocking(move || (sample(&[p]), sample(&[me])))
            .await
            .unwrap_or_default();
        let now = Instant::now();
        let cnt = [
            l(&sh.c.frames_in),
            l(&sh.c.updates_out),
            l(&sh.c.awareness_out),
            l(&sh.c.dropped),
            l(&sh.c.reconnects),
            l(&sh.c.ws_err) + l(&sh.c.launch_err),
            l(&sh.c.refused),
        ];
        let secs = now.duration_since(prev.0).as_secs_f64();
        let d = |i: usize| cnt[i] - prev.3[i];
        let srv_cpu = if prev.4 == p {
            (srv.cpu - prev.1.cpu) / secs * 100.0
        } else {
            f64::NAN
        };
        let me_cpu = (mine.cpu - prev.2.cpu) / secs * 100.0;
        let ms = |us: f64| (us / 100.0).round() / 10.0;
        let row = json!({
            "tSecs": until.as_secs(),
            "live": sh.c.live.load(Ordering::Relaxed),
            "latMs": {"p50": ms(pct(&lat, 0.5)), "p95": ms(pct(&lat, 0.95)), "p99": ms(pct(&lat, 0.99)),
                      "max": ms(lat.last().copied().unwrap_or(0) as f64), "samples": lat.len()},
            "server": {"cpuPct": (srv_cpu * 10.0).round() / 10.0, "rssMb": (srv.rss_kb as f64 / 102.4).round() / 10.0},
            "loadgenCpuPct": me_cpu.round(),
            "framesInPerSec": (d(0) as f64 / secs).round(),
            "updatesOutPerSec": (d(1) as f64 / secs).round(),
            "awarenessOutPerSec": (d(2) as f64 / secs).round(),
            "drops": d(3), "reconnects": d(4), "errors": d(5), "refusedFull": d(6),
            "fault": faulted_in_bucket.take(),
        });
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {:.0} | {:.0} | {:.0} | {} | {} | {} | {} | {} | {} | {} | {} |",
            row["tSecs"],
            row["live"],
            row["latMs"]["p50"],
            row["latMs"]["p95"],
            row["latMs"]["p99"],
            row["latMs"]["max"],
            lat.len(),
            srv_cpu,
            srv.rss_kb as f64 / 1024.0,
            me_cpu,
            row["framesInPerSec"],
            row["updatesOutPerSec"],
            row["awarenessOutPerSec"],
            d(3),
            d(4),
            d(5),
            d(6),
            row["fault"].as_str().unwrap_or("")
        );
        rows.push(row);
        prev = (now, srv, mine, cnt, p);
    }
    sh.stopping.store(true, Ordering::Relaxed);
    let mut rec = std::mem::take(&mut *sh.reconnect_ms.lock().expect("lock"));
    rec.sort_unstable();
    let live_end = sh.c.live.load(Ordering::Relaxed);

    // Pass rules.
    let mut rules = Vec::new();
    let in_grace = |t: f64| {
        fault_log.iter().any(|f| {
            let at = f["atSecs"].as_f64().unwrap_or(0.0);
            // A bucket ending at t covers (t - bucket, t].
            t > at && t - sc.run.bucket_secs as f64 <= at + sc.pass.p99_grace_secs as f64
        })
    };
    let p99s: Vec<(f64, f64)> = rows
        .iter()
        .map(|r| {
            (
                r["tSecs"].as_f64().unwrap_or(0.0),
                r["latMs"]["p99"].as_f64().unwrap_or(f64::NAN),
            )
        })
        .collect();
    if let Some(lim) = sc.pass.p99_ms {
        let worst = p99s
            .iter()
            .filter(|(t, _)| !in_grace(*t))
            .map(|(_, v)| if v.is_nan() { f64::INFINITY } else { *v })
            .fold(0.0_f64, f64::max);
        rules.push(json!({"rule": format!("p99 < {lim} ms in every bucket (except {} s after a fault)", sc.pass.p99_grace_secs),
                          "value": if worst.is_finite() { json!(worst) } else { json!("no samples") }, "pass": worst < lim}));
    }
    // Every client of the scenario connected (a full room, 1013, refuses peers past the cap).
    rules.push(json!({"rule": format!("all {n} clients connected"),
                      "value": {"liveEnd": live_end, "refusedFull": l(&sh.c.refused)}, "pass": live_end as usize >= n}));
    let rss_max = rows
        .iter()
        .filter_map(|r| r["server"]["rssMb"].as_f64())
        .fold(0.0, f64::max);
    if let Some(lim) = sc.pass.rss_mb {
        rules.push(
            json!({"rule": format!("RSS < {lim} MB"), "value": rss_max, "pass": rss_max < lim}),
        );
    }
    if let Some(pct_lim) = sc.pass.rss_drift_pct {
        let rss: Vec<f64> = rows
            .iter()
            .filter_map(|r| r["server"]["rssMb"].as_f64())
            .collect();
        let (first, last) = (
            rss.first().copied().unwrap_or(0.0),
            rss.last().copied().unwrap_or(0.0),
        );
        let drift = if first > 0.0 {
            (last - first) / first * 100.0
        } else {
            f64::NAN
        };
        rules.push(
            json!({"rule": format!("RSS within ± {pct_lim}% after warm-up (first bucket to last)"),
                          "value": (drift * 10.0).round() / 10.0, "pass": drift.abs() <= pct_lim}),
        );
    }
    if sc.pass.no_drops {
        let drops: u64 = rows
            .iter()
            .filter(|r| r["fault"].is_null())
            .map(|r| r["drops"].as_u64().unwrap_or(0))
            .sum();
        rules.push(json!({"rule": "no drops outside the fault buckets", "value": drops, "pass": drops == 0}));
    }
    if let Some(lim) = sc.pass.reconnect_secs
        && !fault_log.is_empty()
    {
        let max = rec.last().copied().unwrap_or(0) as f64 / 1000.0;
        let before = fault_log[0]["liveBefore"].as_u64().unwrap_or(0);
        let ok = max < lim && live_end >= before;
        rules.push(json!({"rule": format!("every client back < {lim} s"),
                          "value": {"maxSecs": max, "p95Secs": pct(&rec, 0.95) / 1000.0, "reconnected": rec.len(), "liveBefore": before, "liveEnd": live_end},
                          "pass": ok}));
    }
    if let Some(lim) = sc.pass.recover_secs
        && let Some(f) = fault_log.first()
    {
        let at = f["atSecs"].as_f64().unwrap_or(0.0);
        let mut before: Vec<f64> = p99s
            .iter()
            .filter(|(t, v)| *t <= at && !v.is_nan())
            .map(|x| x.1)
            .collect();
        before.sort_by(f64::total_cmp);
        let normal = before.get(before.len() / 2).copied().unwrap_or(f64::NAN) * 1.5;
        let back = p99s
            .iter()
            .find(|(t, v)| *t > at + sc.run.bucket_secs as f64 && *v <= normal)
            .map(|(t, _)| t - at);
        rules.push(json!({"rule": format!("p99 back within 1.5× the pre-fault median in < {lim} s"),
                          "value": {"normalMs": normal, "backAfterSecs": back}, "pass": back.is_some_and(|b| b <= lim)}));
    }

    let commit = sh_out("git", &["rev-parse", "--short", "HEAD"]);
    let dirty = !sh_out("git", &["status", "--porcelain", "--untracked-files=no"]).is_empty();
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let date = sh_out("date", &["-u", "+%Y-%m-%d"]);
    let report = json!({
        "scenario": sc.name, "description": sc.description, "size": size,
        "overrides": cli, "scenarioFile": file, "scenarioSha256": hash,
        "date": date, "commit": commit, "dirty": dirty,
        "machine": machine, "hardware": hardware(),
        "loadAvg": {"start": load_start, "end": loadavg()}, "targetMachine": sc.machine,
        "store": store,
        "load": {"connections": n, "rooms": rooms, "docs": sc.load.docs, "connectRate": sc.load.connect_rate,
                 "probesPerRoom": sc.load.probes_per_room, "sourceAddrs": sc.load.source_addrs},
        "mix": {"stated": sc.mix, "roles": {"idle": roles[0], "presence": roles[1], "typing": roles[2]},
                "typist": "types steadily at typing_hz chars/s with no pauses; 6% of its edits are database cells and 2% start a 10-step board drag"},
        "minutes": sc.run.minutes, "bucketSecs": sc.run.bucket_secs,
        "serverEnv": sc.server_env,
        "ramp": {"secs": (ramp_secs * 10.0).round() / 10.0, "ready": ready_after_ramp, "connectMs": {"p50": pct(&con, 0.5), "p95": pct(&con, 0.95), "max": con.last().copied().unwrap_or(0)}},
        "faults": fault_log,
        "reconnectMs": {"n": rec.len(), "p50": pct(&rec, 0.5), "p95": pct(&rec, 0.95), "max": rec.last().copied().unwrap_or(0)},
        "buckets": rows,
        "rssMaxMb": rss_max,
        "liveEnd": live_end,
        "host": {"loads": host_stats.loads.load(Ordering::Relaxed), "saves": host_stats.saves.load(Ordering::Relaxed)},
        "closes": *sh.closes.lock().expect("lock"),
        "errors": *sh.errors.lock().expect("lock"),
        "pass": rules,
        "passed": rules.iter().all(|r| r["pass"] == true),
        "notMeasured": sc.not_measured,
        "timeline": *timeline.lock().expect("lock"),
    });
    println!("pass rules:");
    for r in &rules {
        println!(
            "  {} {}: {}",
            if r["pass"] == true { "PASS" } else { "FAIL" },
            r["rule"].as_str().unwrap_or(""),
            r["value"]
        );
    }
    for m in &sc.not_measured {
        println!("  not measured: {m}");
    }
    let out = match a.0.get("out") {
        Some(o) => o.clone(),
        None => {
            let dir = a.s("results-dir", "bench/results");
            std::fs::create_dir_all(&dir)?;
            format!(
                "{dir}/{date}-{}-{size}-{machine}.json",
                sc.name.to_lowercase()
            )
        }
    };
    std::fs::write(&out, serde_json::to_vec_pretty(&report)?)?;
    println!("result: {out}");
    server.stop();
    // `--strict 1` (CI): a failed pass rule fails the run.
    let failed = !rules.iter().all(|r| r["pass"] == true);
    std::process::exit(if failed && a.s("strict", "0") == "1" {
        1
    } else {
        0
    });
}
