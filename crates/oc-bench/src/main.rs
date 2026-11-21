//! `oc-bench`: load generator for OpenCanvas capacity runs (docs/22-CAPACITY-AND-SIZING.md).
//!
//!   oc-bench run --server http://127.0.0.1:8701 --server-pid <pid> --host-port 8702 \
//!       --per-room 5 --editors 0.2 --steps 100,500,1000 --step-secs 20 --out run.json
//!   oc-bench sizes            # encoded size of the seed documents
//!
//! It mints launch tokens for the bench host entry (HS256), serves that host's load/save
//! callbacks itself (in-process mock, [`mockhost`]), opens N WebSocket clients over M rooms in
//! steps, and at every step measures end-to-end update latency, connect time, errors and the
//! server's CPU, RSS, threads and open fds (`ps`, `lsof`) plus its `/metrics`.
//! `scripts/bench.sh` runs the whole suite.

mod client;
mod docs;
mod mockhost;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use client::{Counters, RunCfg, Shared, Spec, run_user};
use docs::DocKind;

struct Args(HashMap<String, String>);

impl Args {
    fn parse(v: &[String]) -> anyhow::Result<Self> {
        let mut m = HashMap::new();
        let mut it = v.iter();
        while let Some(k) = it.next() {
            let Some(k) = k.strip_prefix("--") else {
                anyhow::bail!("unexpected argument {k}");
            };
            let val = it
                .next()
                .ok_or_else(|| anyhow::anyhow!("--{k} needs a value"))?;
            m.insert(k.to_string(), val.clone());
        }
        Ok(Self(m))
    }
    fn s(&self, k: &str, d: &str) -> String {
        self.0.get(k).cloned().unwrap_or_else(|| d.to_string())
    }
    fn n<T: std::str::FromStr>(&self, k: &str, d: T) -> T {
        self.0.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
}

/// CPU seconds (user + system) and RSS (KB) of a process, from `ps`.
fn ps(pid: u32) -> Option<(f64, u64)> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=,time=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let mut f = s.split_whitespace();
    let rss = f.next()?.parse().ok()?;
    let mut secs = 0.0;
    for part in f.next()?.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    Some((secs, rss))
}

fn count_lines(cmd: &str, args: &[&str]) -> u64 {
    std::process::Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.stdout.iter().filter(|b| **b == b'\n').count() as u64)
        .unwrap_or(0)
        .saturating_sub(1)
}

fn threads(pid: u32) -> u64 {
    count_lines("ps", &["-M", "-p", &pid.to_string()])
}

fn fds(pid: u32) -> u64 {
    count_lines("lsof", &["-n", "-P", "-p", &pid.to_string()])
}

#[derive(Clone, Copy, Default)]
struct Proc {
    cpu: f64,
    rss_kb: u64,
}

/// Sum over the server pids (cluster: several nodes).
fn sample(pids: &[u32]) -> Proc {
    let mut p = Proc::default();
    for pid in pids {
        if let Some((cpu, rss)) = ps(*pid) {
            p.cpu += cpu;
            p.rss_kb += rss;
        }
    }
    p
}

async fn metrics(http: &reqwest::Client, bases: &[String]) -> HashMap<String, f64> {
    let mut m = HashMap::new();
    for b in bases {
        let Ok(r) = http.get(format!("{b}/metrics")).send().await else {
            continue;
        };
        let Ok(t) = r.text().await else { continue };
        for line in t.lines().filter(|l| !l.starts_with('#')) {
            let mut f = line.split_whitespace();
            if let (Some(k), Some(v)) = (f.next(), f.next().and_then(|v| v.parse::<f64>().ok())) {
                *m.entry(k.to_string()).or_default() += v;
            }
        }
    }
    m
}

fn pct(sorted: &[u32], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[i] as f64
}

fn file_size(p: &str) -> u64 {
    std::fs::metadata(p).map_or(0, |m| m.len())
}

fn sqlite_bytes(path: &str) -> u64 {
    if path.is_empty() {
        return 0;
    }
    file_size(path) + file_size(&format!("{path}-wal"))
}

struct Snap {
    at: Instant,
    srv: Proc,
    me: Proc,
    m: HashMap<String, f64>,
    c: [u64; 9],
}

fn counters(c: &Counters) -> [u64; 9] {
    let l = |a: &std::sync::atomic::AtomicU64| a.load(Ordering::Relaxed);
    [
        l(&c.updates_out),
        l(&c.awareness_out),
        l(&c.frames_in),
        l(&c.bytes_in),
        l(&c.bytes_out),
        l(&c.launch_err) + l(&c.ws_err),
        l(&c.dropped),
        l(&c.update_bytes_out),
        l(&c.denied),
    ]
}

async fn snap(sh: &Shared, pids: &[u32]) -> Snap {
    let pids2 = pids.to_vec();
    let (srv, me) =
        tokio::task::spawn_blocking(move || (sample(&pids2), sample(&[std::process::id()])))
            .await
            .unwrap_or_default();
    Snap {
        at: Instant::now(),
        srv,
        me,
        m: metrics(&sh.http, &sh.cfg.http_base).await,
        c: counters(&sh.c),
    }
}

fn editor_at(k: usize, frac: f64) -> bool {
    ((k + 1) as f64 * frac).floor() > (k as f64 * frac).floor()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.first().map(String::as_str) {
        Some("run") => run(Args::parse(&argv[1..])?).await,
        Some("sizes") => {
            for k in [DocKind::Empty, DocKind::Demo, DocKind::Big] {
                let ocanvas = docs::ocanvas(k)?.map_or(0, |b| b.len());
                println!(
                    "{:<6} ydoc {:>9} B   .ocanvas {:>9} B",
                    k.name(),
                    docs::ydoc_len(k),
                    ocanvas
                );
            }
            Ok(())
        }
        _ => {
            eprintln!(
                "usage: oc-bench run --server URL[,URL…] --server-pid PID[,PID…] [options] | oc-bench sizes\n(see crates/oc-bench/src/main.rs and docs/22)"
            );
            std::process::exit(2);
        }
    }
}

async fn run(a: Args) -> anyhow::Result<()> {
    let http_base: Vec<String> = a
        .s("server", "http://127.0.0.1:8701")
        .split(',')
        .map(|s| s.trim_end_matches('/').to_string())
        .collect();
    let ws_base = http_base
        .iter()
        .map(|b| {
            b.replacen("http://", "ws://", 1)
                .replacen("https://", "wss://", 1)
        })
        .collect();
    let pids: Vec<u32> = a
        .s("server-pid", "")
        .split(',')
        .filter_map(|p| p.parse().ok())
        .collect();
    let per_room: usize = a.n("per-room", 5);
    // --rooms R: deal clients round-robin over a fixed set of R rooms instead of filling rooms
    // of --per-room one after the other.
    let fixed_rooms: usize = a.n("rooms", 0);
    let editors: f64 = a.n("editors", 0.2);
    let probes: usize = a.n("probes", 4);
    let steps: Vec<usize> = a
        .s("steps", "10,50,100")
        .split(',')
        .filter_map(|s| s.parse().ok())
        .collect();
    let step_secs: u64 = a.n("step-secs", 20);
    let settle_secs: u64 = a.n("settle-secs", 5);
    let rate: f64 = a.n("connect-rate", 200.0);
    let active: f64 = a.n("active", 0.6);
    let cps: Vec<f64> = a
        .s("cps", "3,6")
        .split(',')
        .filter_map(|s| s.parse().ok())
        .collect();
    let sqlite = a.s("sqlite", "");
    let label = a.s("label", "run");
    let host_stats = Arc::new(mockhost::HostStats::default());
    let host_port: u16 = a.n("host-port", 8702);
    if host_port != 0 {
        mockhost::serve(host_port, host_stats.clone()).await?;
    }
    let run_id = a.s(
        "run-id",
        &format!(
            "{}{}",
            label.replace(|c: char| !c.is_ascii_alphanumeric(), ""),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_secs()
                % 100_000
        ),
    );
    let sh = Arc::new(Shared {
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(256)
            .build()?,
        cfg: RunCfg {
            http_base,
            ws_base,
            sticky: a.s("affinity", "hash") == "hash",
            secret: a.s("secret", "bench-secret-0123456789abcdef0123456789"),
            host_id: a.s("host-id", "bench"),
            run_id,
            doc: DocKind::parse(&a.s("doc", "empty"))?,
            cps: (
                cps.first().copied().unwrap_or(3.0),
                cps.get(1).copied().unwrap_or(6.0),
            ),
            active: active.clamp(0.01, 1.0),
        },
        host: host_stats.clone(),
        sent: Default::default(),
        lat_us: Default::default(),
        connect_ms: Default::default(),
        c: Counters::default(),
        closes: Default::default(),
        errors: Default::default(),
        quiet: (active <= 0.0).into(),
    });

    // 1 Hz timeline of the server process.
    let timeline: Arc<Mutex<Vec<Value>>> = Arc::default();
    {
        let (tl, pids, sh) = (timeline.clone(), pids.clone(), sh.clone());
        tokio::spawn(async move {
            let t0 = Instant::now();
            let mut prev: Option<(Instant, Proc)> = None;
            loop {
                let p2 = pids.clone();
                let p = tokio::task::spawn_blocking(move || sample(&p2))
                    .await
                    .unwrap_or_default();
                let now = Instant::now();
                let cpu = prev.map_or(0.0, |(t, q)| {
                    (p.cpu - q.cpu) / now.duration_since(t).as_secs_f64() * 100.0
                });
                prev = Some((now, p));
                tl.lock().expect("lock").push(json!({
                    "t": t0.elapsed().as_secs(), "cpu": (cpu * 10.0).round() / 10.0,
                    "rssMb": p.rss_kb / 1024, "live": sh.c.live.load(Ordering::Relaxed),
                }));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    let base_snap = snap(&sh, &pids).await;
    let base_rss = base_snap.srv.rss_kb;
    let mut rows = Vec::new();
    let mut spawned = 0usize;
    let gate = Arc::new(tokio::sync::Semaphore::new(a.n("max-inflight", 128)));
    println!(
        "# {label}: per-room {per_room}, editors {editors}, doc {}, steps {steps:?}, {step_secs}s/step; server RSS at start {} MB",
        sh.cfg.doc.name(),
        base_rss / 1024
    );
    println!(
        "| clients | live | rooms | p50 ms | p95 ms | p99 ms | samples | srv CPU % | RSS MB | thr | fds | upd/s in | frames/s out | MB/s out | err | drop | connect p95 ms |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for &target in &steps {
        let ramp_start = Instant::now();
        let gap = Duration::from_secs_f64(1.0 / rate.max(1.0));
        while spawned < target {
            let (room, k) = if fixed_rooms > 0 {
                (spawned % fixed_rooms, spawned / fixed_rooms)
            } else {
                (spawned / per_room, spawned % per_room)
            };
            let spec = Spec {
                idx: spawned,
                room,
                editor: editor_at(k, editors),
                probe: k < probes,
            };
            let (sh2, permit) = (sh.clone(), gate.clone().acquire_owned().await?);
            tokio::spawn(async move {
                // The permit covers launch + connect only.
                let sh3 = sh2.clone();
                let watch = tokio::spawn(async move {
                    let t = Instant::now();
                    while t.elapsed() < Duration::from_secs(30) {
                        let done = sh3.c.ready.load(Ordering::Relaxed)
                            + sh3.c.launch_err.load(Ordering::Relaxed)
                            + sh3.c.ws_err.load(Ordering::Relaxed);
                        if done > spec.idx as u64 {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    drop(permit);
                });
                run_user(sh2, spec).await;
                watch.abort();
            });
            spawned += 1;
            tokio::time::sleep(gap).await;
        }
        // Wait for every client to be ready or failed (≤ 120 s).
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(120) {
            let done = sh.c.ready.load(Ordering::Relaxed)
                + sh.c.launch_err.load(Ordering::Relaxed)
                + sh.c.ws_err.load(Ordering::Relaxed);
            if done >= target as u64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let ramp_secs = ramp_start.elapsed().as_secs_f64();
        tokio::time::sleep(Duration::from_secs(settle_secs)).await;
        sh.lat_us.lock().expect("lock").clear();
        let connects: Vec<u32> = std::mem::take(&mut *sh.connect_ms.lock().expect("lock"));
        let s0 = snap(&sh, &pids).await;
        tokio::time::sleep(Duration::from_secs(step_secs)).await;
        let s1 = snap(&sh, &pids).await;
        let mut lat = std::mem::take(&mut *sh.lat_us.lock().expect("lock"));
        lat.sort_unstable();
        let mut con = connects;
        con.sort_unstable();
        let secs = s1.at.duration_since(s0.at).as_secs_f64();
        let d = |i: usize| (s1.c[i] - s0.c[i]) as f64 / secs;
        let md = |k: &str| {
            (s1.m.get(k).copied().unwrap_or(0.0) - s0.m.get(k).copied().unwrap_or(0.0)) / secs
        };
        let pids2 = pids.clone();
        let (thr, fd) = tokio::task::spawn_blocking(move || {
            (
                pids2.iter().map(|p| threads(*p)).sum::<u64>(),
                pids2.iter().map(|p| fds(*p)).sum::<u64>(),
            )
        })
        .await
        .unwrap_or_default();
        let srv_cpu = (s1.srv.cpu - s0.srv.cpu) / secs * 100.0;
        let me_cpu = (s1.me.cpu - s0.me.cpu) / secs * 100.0;
        let live = sh.c.live.load(Ordering::Relaxed);
        let ms = |us: f64| (us / 100.0).round() / 10.0;
        let row = json!({
            "target": target,
            "live": live,
            "rooms": if fixed_rooms > 0 { fixed_rooms.min(target) } else { target.div_ceil(per_room) },
            "rampSecs": (ramp_secs * 10.0).round() / 10.0,
            "latMs": {"p50": ms(pct(&lat, 0.5)), "p95": ms(pct(&lat, 0.95)), "p99": ms(pct(&lat, 0.99)),
                      "max": ms(lat.last().copied().unwrap_or(0) as f64), "samples": lat.len()},
            "connectMs": {"p50": pct(&con, 0.5), "p95": pct(&con, 0.95), "max": con.last().copied().unwrap_or(0), "n": con.len()},
            "server": {"cpuPct": (srv_cpu * 10.0).round() / 10.0, "rssMb": s1.srv.rss_kb as f64 / 1024.0,
                       "rssDeltaMb": (s1.srv.rss_kb as f64 - base_rss as f64) / 1024.0,
                       "threads": thr, "fds": fd},
            "loadgenCpuPct": (me_cpu * 10.0).round() / 10.0,
            "metrics": {"connections": s1.m.get("oc_connections_active"), "rooms": s1.m.get("oc_rooms_active"),
                        "updatesPerSec": md("oc_updates_total"), "savesPerSec": md("oc_saves_total"),
                        "saveErrors": s1.m.get("oc_save_errors_total"), "rejected": s1.m.get("oc_updates_rejected_total")},
            "client": {"updatesSentPerSec": d(0), "awarenessSentPerSec": d(1), "framesRecvPerSec": d(2),
                       "mbRecvPerSec": d(3) / 1e6, "mbSentPerSec": d(4) / 1e6, "updateBytesPerSec": d(7)},
            "errors": s1.c[5], "dropped": s1.c[6], "denied": s1.c[8],
            "dbBytes": sqlite_bytes(&sqlite),
        });
        println!(
            "| {target} | {live} | {} | {} | {} | {} | {} | {:.0} | {:.0} | {thr} | {fd} | {:.0} | {:.0} | {:.2} | {} | {} | {} |",
            row["rooms"],
            row["latMs"]["p50"],
            row["latMs"]["p95"],
            row["latMs"]["p99"],
            lat.len(),
            srv_cpu,
            s1.srv.rss_kb as f64 / 1024.0,
            md("oc_updates_total"),
            d(2),
            d(3) / 1e6,
            s1.c[5],
            s1.c[6],
            pct(&con, 0.95),
        );
        rows.push(row);
        if (live as usize) < target / 2 && target > 20 {
            println!("(stopping: fewer than half the clients are connected)");
            break;
        }
    }

    // Autosave view from the mock host.
    let mut lag = host_stats.save_lag_ms.lock().expect("lock").clone();
    lag.sort_unstable();
    let host = json!({
        "loads": host_stats.loads.load(Ordering::Relaxed),
        "saves": host_stats.saves.load(Ordering::Relaxed),
        "saveBytes": host_stats.save_bytes.load(Ordering::Relaxed),
        "saveLagMs": {"p50": pct(&lag, 0.5), "p95": pct(&lag, 0.95), "max": lag.last().copied().unwrap_or(0), "n": lag.len()},
    });
    let report = json!({
        "label": label,
        "config": {"perRoom": per_room, "editors": editors, "probes": probes, "doc": sh.cfg.doc.name(),
                   "stepSecs": step_secs, "connectRate": rate, "active": active, "cps": cps,
                   "servers": sh.cfg.http_base, "sticky": sh.cfg.sticky},
        "baseRssMb": base_rss as f64 / 1024.0,
        "steps": rows,
        "host": host,
        "closes": *sh.closes.lock().expect("lock"),
        "errors": *sh.errors.lock().expect("lock"),
        "timeline": *timeline.lock().expect("lock"),
    });
    println!(
        "host: {}  closes: {}  errors: {}",
        report["host"], report["closes"], report["errors"]
    );
    if let Some(out) = a.0.get("out") {
        std::fs::write(out, serde_json::to_vec_pretty(&report)?)?;
    }
    // Leave politely: closing sockets lets rooms save (last client leaves).
    std::process::exit(0);
}
