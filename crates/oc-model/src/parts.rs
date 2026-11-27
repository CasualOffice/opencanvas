// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Partial sync (PSYNC-02, ADR-076): the room splits a canvas into a main document and one part
//! per heavy block (each `databases` and `boards` entry), and flattens the parts back into the
//! format v1 update on save. **Item ids are kept.** A part is the subset of the original update
//! whose items descend from that block's map entry, so a part *is* a Yjs document (root
//! `databases` or `boards` with that one key) that any client or the room can load, and the
//! flatten is a byte merge of the parts' structs.
//!
//! Clocks stay contiguous in every part: where a client's clock range belongs to another part,
//! the part carries a GC struct of the same length (a "filler"). GC is what Yjs keeps for
//! garbage-collected items: it has no content, no parent and is never shown, so a filler costs
//! a few bytes and every part integrates in a stock Yjs or yrs document. The flatten takes each
//! clock range from the part that owns an item there and keeps GC only where nobody does; the
//! delete set of each part counts only for the items it owns (its fillers are GC everywhere).
//!
//! Who owns an item: the part of its parent, recursively; an item without encoded parent info
//! (it has an origin) has the parent of its origin. An item whose parent is the root `databases`
//! or `boards` with key `k` starts part `databases/k` or `boards/k`. GC and anything unresolved
//! belongs to the main document.
//!
//! [`route`] cuts an incremental update (an edit made on a whole, flattened view) the same way,
//! asking an [`Owners`] index for ids outside the update, and prefixes each part's share with
//! the fillers that part lacks so it stays contiguous.
//!
//! The format is lib0 update v1 as yrs 0.28 writes it (`docs/15 §4`); Move and sub-document
//! contents are refused ([`Error::Unsupported`]), the canvas never writes them.

use std::collections::{BTreeMap, HashMap};

use crate::roots;

/// The main document's part key.
pub const MAIN: &str = "";
/// Roots whose entries become parts.
pub const SPLIT_ROOTS: [&str; 2] = [roots::DATABASES, roots::BOARDS];

/// `databases/<blockId>` or `boards/<blockId>`; [`MAIN`] for the main document.
pub type PartKey = String;

pub fn part_key(root: &str, key: &str) -> Option<PartKey> {
    SPLIT_ROOTS.contains(&root).then(|| format!("{root}/{key}"))
}

/// `(root, block id)` of a part key.
pub fn part_root(part: &str) -> Option<(&str, &str)> {
    part.split_once('/')
        .filter(|(r, _)| SPLIT_ROOTS.contains(r))
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("update truncated or malformed")]
    Malformed,
    #[error("unsupported struct content {0}")]
    Unsupported(u8),
    #[error("parts disagree on client {client} clock {clock}")]
    Clash { client: u64, clock: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Id {
    pub client: u64,
    pub clock: u32,
}

#[derive(Debug, Clone)]
enum Parent {
    /// Not encoded: the parent of the origin (or right origin).
    Inferred,
    /// The root's name, as a byte range of the update (no allocation per item).
    Named((usize, usize)),
    Id(Id),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Gc,
    Skip,
    Item,
}

#[derive(Debug, Clone)]
struct Struct {
    clock: u32,
    len: u32,
    kind: Kind,
    /// Byte range of the encoded struct in the source update.
    raw: (usize, usize),
    origin: Option<Id>,
    right: Option<Id>,
    parent: Parent,
    /// The parent map key, as a byte range of the update.
    sub: Option<(usize, usize)>,
}

impl Struct {
    fn end(&self) -> u32 {
        self.clock + self.len
    }
}

struct Parsed<'a> {
    buf: &'a [u8],
    /// In encoded order.
    clients: Vec<(u64, Vec<Struct>)>,
    ds: Vec<(u64, Vec<(u32, u32)>)>,
}

impl Parsed<'_> {
    fn raw(&self, s: &Struct) -> &[u8] {
        &self.buf[s.raw.0..s.raw.1]
    }
}

// ---- lib0 v1 reading -------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, Error> {
        let b = *self.buf.get(self.pos).ok_or(Error::Malformed)?;
        self.pos += 1;
        Ok(b)
    }

    fn var(&mut self) -> Result<u64, Error> {
        let mut out: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.u8()?;
            if shift < 64 {
                out |= u64::from(b & 0x7f) << shift;
            }
            if b & 0x80 == 0 {
                return Ok(out);
            }
            shift += 7;
            if shift > 70 {
                return Err(Error::Malformed);
            }
        }
    }

    fn var32(&mut self) -> Result<u32, Error> {
        u32::try_from(self.var()?).map_err(|_| Error::Malformed)
    }

    /// Skips a signed or unsigned varint.
    fn skip_var(&mut self) -> Result<(), Error> {
        while self.u8()? & 0x80 != 0 {}
        Ok(())
    }

    fn skip(&mut self, n: usize) -> Result<(), Error> {
        if self.buf.len() - self.pos < n {
            return Err(Error::Malformed);
        }
        self.pos += n;
        Ok(())
    }

    fn bytes(&mut self) -> Result<&'a [u8], Error> {
        let n = usize::try_from(self.var()?).map_err(|_| Error::Malformed)?;
        let start = self.pos;
        self.skip(n)?;
        Ok(&self.buf[start..start + n])
    }

    fn string(&mut self) -> Result<&'a str, Error> {
        std::str::from_utf8(self.bytes()?).map_err(|_| Error::Malformed)
    }

    /// A string's byte range (checked UTF-8), without copying it.
    fn str_range(&mut self) -> Result<(usize, usize), Error> {
        let b = self.bytes()?;
        std::str::from_utf8(b).map_err(|_| Error::Malformed)?;
        let start = self.pos - b.len();
        Ok((start, self.pos))
    }

    fn id(&mut self) -> Result<Id, Error> {
        Ok(Id {
            client: self.var()?,
            clock: self.var32()?,
        })
    }

    fn any(&mut self, depth: u32) -> Result<(), Error> {
        if depth > 64 {
            return Err(Error::Malformed);
        }
        match self.u8()? {
            127 | 126 | 121 | 120 => Ok(()),
            125 => self.skip_var(),
            124 => self.skip(4),
            123 | 122 => self.skip(8),
            119 | 116 => self.bytes().map(|_| ()),
            118 => {
                for _ in 0..self.var()? {
                    self.bytes()?;
                    self.any(depth + 1)?;
                }
                Ok(())
            }
            117 => {
                for _ in 0..self.var()? {
                    self.any(depth + 1)?;
                }
                Ok(())
            }
            t => Err(Error::Unsupported(t)),
        }
    }
}

fn parse(buf: &[u8]) -> Result<Parsed<'_>, Error> {
    let mut r = Reader { buf, pos: 0 };
    let n_clients = r.var()?;
    let mut clients = Vec::new();
    for _ in 0..n_clients {
        let n = r.var()?;
        let client = r.var()?;
        let mut clock = r.var32()?;
        let mut structs = Vec::new();
        for _ in 0..n {
            let s = parse_struct(&mut r, clock)?;
            clock = clock.checked_add(s.len).ok_or(Error::Malformed)?;
            structs.push(s);
        }
        clients.push((client, structs));
    }
    let mut ds = Vec::new();
    // An update without a delete set section (never written by yrs) reads as empty.
    if r.pos < buf.len() {
        for _ in 0..r.var()? {
            let client = r.var()?;
            let mut ranges = Vec::new();
            for _ in 0..r.var()? {
                let clock = r.var32()?;
                let len = r.var32()?;
                ranges.push((clock, clock.checked_add(len).ok_or(Error::Malformed)?));
            }
            ds.push((client, ranges));
        }
    }
    Ok(Parsed { buf, clients, ds })
}

fn parse_struct(r: &mut Reader, clock: u32) -> Result<Struct, Error> {
    let start = r.pos;
    let info = r.u8()?;
    let mut s = Struct {
        clock,
        len: 0,
        kind: Kind::Item,
        raw: (start, start),
        origin: None,
        right: None,
        parent: Parent::Inferred,
        sub: None,
    };
    match info & 0x1f {
        0 => {
            s.kind = Kind::Gc;
            s.len = r.var32()?;
        }
        10 => {
            s.kind = Kind::Skip;
            s.len = r.var32()?;
        }
        content => {
            if info & 0x80 != 0 {
                s.origin = Some(r.id()?);
            }
            if info & 0x40 != 0 {
                s.right = Some(r.id()?);
            }
            if info & 0xc0 == 0 {
                s.parent = if r.var()? == 1 {
                    Parent::Named(r.str_range()?)
                } else {
                    Parent::Id(r.id()?)
                };
                if info & 0x20 != 0 {
                    s.sub = Some(r.str_range()?);
                }
            }
            s.len = match content {
                1 => r.var32()?,
                2 => {
                    let n = r.var32()?;
                    for _ in 0..n {
                        r.bytes()?;
                    }
                    n
                }
                3 | 5 => {
                    r.bytes()?;
                    1
                }
                4 => {
                    let n = r.string()?.encode_utf16().count();
                    u32::try_from(n).map_err(|_| Error::Malformed)?
                }
                6 => {
                    r.bytes()?;
                    r.bytes()?;
                    1
                }
                7 => {
                    match r.u8()? {
                        3 => {
                            r.bytes()?;
                        }
                        0..=6 | 9 | 15 => {}
                        t => return Err(Error::Unsupported(100 + t)),
                    }
                    1
                }
                8 => {
                    let n = r.var32()?;
                    for _ in 0..n {
                        r.any(0)?;
                    }
                    n
                }
                c => return Err(Error::Unsupported(c)),
            };
        }
    }
    if s.len == 0 {
        return Err(Error::Malformed);
    }
    s.raw.1 = r.pos;
    Ok(s)
}

// ---- lib0 v1 writing -------------------------------------------------------------------------

fn put_var(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_gc(out: &mut Vec<u8>, len: u32) {
    out.push(0);
    put_var(out, u64::from(len));
}

fn put_skip(out: &mut Vec<u8>, len: u32) {
    out.push(10);
    put_var(out, u64::from(len));
}

/// One client's struct section being written: raw structs and merged GC runs.
enum Piece<'a> {
    Raw(&'a [u8]),
    Gc(u32),
    Skip(u32),
}

fn push_piece<'a>(pieces: &mut Vec<Piece<'a>>, p: Piece<'a>) {
    match (pieces.last_mut(), &p) {
        (Some(Piece::Gc(a)), Piece::Gc(b)) => *a += b,
        (Some(Piece::Skip(a)), Piece::Skip(b)) => *a += b,
        _ => pieces.push(p),
    }
}

fn write_client(out: &mut Vec<u8>, client: u64, clock: u32, pieces: &[Piece]) {
    put_var(out, pieces.len() as u64);
    put_var(out, client);
    put_var(out, u64::from(clock));
    for p in pieces {
        match p {
            Piece::Raw(b) => out.extend_from_slice(b),
            Piece::Gc(n) => put_gc(out, *n),
            Piece::Skip(n) => put_skip(out, *n),
        }
    }
}

fn write_ds(out: &mut Vec<u8>, ds: &BTreeMap<u64, Vec<(u32, u32)>>) {
    let clients: Vec<_> = ds.iter().rev().filter(|(_, r)| !r.is_empty()).collect();
    put_var(out, clients.len() as u64);
    for (client, ranges) in clients {
        put_var(out, *client);
        put_var(out, ranges.len() as u64);
        for (a, b) in ranges {
            put_var(out, u64::from(*a));
            put_var(out, u64::from(b - a));
        }
    }
}

/// Sorts and merges overlapping or adjacent ranges.
fn normalise(ranges: &mut Vec<(u32, u32)>) {
    ranges.sort_unstable();
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
    for &(a, b) in ranges.iter() {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    *ranges = out;
}

/// `ranges ∩ owned`, both normalised.
fn intersect(ranges: &[(u32, u32)], owned: &[(u32, u32)]) -> Vec<(u32, u32)> {
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < ranges.len() && j < owned.len() {
        let a = ranges[i].0.max(owned[j].0);
        let b = ranges[i].1.min(owned[j].1);
        if a < b {
            out.push((a, b));
        }
        if ranges[i].1 < owned[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

// ---- ownership -------------------------------------------------------------------------------

/// Which part owns each item, for ids outside the update being cut.
pub trait Owners {
    /// The owner of `id` and the end (exclusive) of the clock range it owns there; `None` when
    /// the id is unknown (GC, or never seen).
    fn owner(&self, id: Id) -> Option<(&str, u32)>;
}

/// Nobody: every outside reference is unknown (a whole update cuts on its own).
pub struct NoOwners;

impl Owners for NoOwners {
    fn owner(&self, _: Id) -> Option<(&str, u32)> {
        None
    }
}

/// Clock ranges per client and the part that owns their items. The room keeps one per split
/// document: a few ranges per client and part (adjacent ranges of one part merge).
#[derive(Debug, Default, Clone)]
pub struct OwnerIndex {
    parts: Vec<PartKey>,
    by_part: HashMap<PartKey, u32>,
    /// client → start → (end, part index)
    ranges: HashMap<u64, BTreeMap<u32, (u32, u32)>>,
}

impl OwnerIndex {
    fn intern(&mut self, part: &str) -> u32 {
        if let Some(i) = self.by_part.get(part) {
            return *i;
        }
        let i = self.parts.len() as u32;
        self.parts.push(part.to_string());
        self.by_part.insert(part.to_string(), i);
        i
    }

    /// Records that `part` owns the items of `client` in `[start, end)`.
    pub fn record(&mut self, client: u64, start: u32, end: u32, part: &str) {
        if start >= end {
            return;
        }
        let p = self.intern(part);
        let map = self.ranges.entry(client).or_default();
        // Drop or trim what the new range covers.
        let overlapping: Vec<u32> = map
            .range(..end)
            .rev()
            .take_while(|(_, (e, _))| *e > start)
            .map(|(s, _)| *s)
            .collect();
        for s in overlapping {
            let (e, q) = map.remove(&s).unwrap_or((s, 0));
            if s < start {
                map.insert(s, (start, q));
            }
            if e > end {
                map.insert(end, (e, q));
            }
        }
        let mut s = start;
        let mut e = end;
        if let Some((&ps, &(pe, pq))) = map.range(..start).next_back()
            && pe == start
            && pq == p
        {
            map.remove(&ps);
            s = ps;
        }
        if let Some(&(ne, nq)) = map.get(&end)
            && nq == p
        {
            map.remove(&end);
            e = ne;
        }
        map.insert(s, (e, p));
    }

    /// Records every item a part's update holds as owned by `part`.
    pub fn record_update(&mut self, part: &str, update: &[u8]) -> Result<(), Error> {
        let parsed = parse(update)?;
        for (client, structs) in &parsed.clients {
            for s in structs.iter().filter(|s| s.kind == Kind::Item) {
                self.record(*client, s.clock, s.end(), part);
            }
        }
        Ok(())
    }

    /// The ranges `part` owns, `(client, start, end)` in order.
    pub fn ranges_of(&self, part: &str) -> Vec<(u64, u32, u32)> {
        let Some(&p) = self.by_part.get(part) else {
            return Vec::new();
        };
        let mut out: Vec<(u64, u32, u32)> = self
            .ranges
            .iter()
            .flat_map(|(c, m)| {
                m.iter()
                    .filter(move |(_, (_, q))| *q == p)
                    .map(move |(s, (e, _))| (*c, *s, *e))
            })
            .collect();
        out.sort_unstable();
        out
    }

    /// The parts that own something.
    pub fn parts(&self) -> impl Iterator<Item = &str> {
        self.parts.iter().map(String::as_str)
    }
}

impl Owners for OwnerIndex {
    fn owner(&self, id: Id) -> Option<(&str, u32)> {
        let (_, &(end, p)) = self
            .ranges
            .get(&id.client)?
            .range(..=id.clock)
            .next_back()?;
        (id.clock < end).then(|| (self.parts[p as usize].as_str(), end))
    }
}

/// Owners of a parsed update's items: `Some(part index)` per struct, resolved iteratively
/// (origin chains are as long as the text).
struct Classes {
    parts: Vec<PartKey>,
    owner: Vec<Vec<Option<u32>>>,
}

fn classify(p: &Parsed, outside: &dyn Owners, splitting: bool) -> Classes {
    let mut parts: Vec<PartKey> = vec![MAIN.to_string()];
    let mut by_part: HashMap<PartKey, u32> = HashMap::from([(MAIN.to_string(), 0)]);
    let mut intern = |k: &str, parts: &mut Vec<PartKey>| -> u32 {
        if let Some(i) = by_part.get(k) {
            return *i;
        }
        let i = parts.len() as u32;
        parts.push(k.to_string());
        by_part.insert(k.to_string(), i);
        i
    };
    let index: HashMap<u64, usize> = p
        .clients
        .iter()
        .enumerate()
        .map(|(i, (c, _))| (*c, i))
        .collect();
    let find = |id: Id| -> Option<(usize, usize)> {
        let ci = *index.get(&id.client)?;
        let structs = &p.clients[ci].1;
        let si = structs.partition_point(|s| s.end() <= id.clock);
        (si < structs.len() && structs[si].clock <= id.clock).then_some((ci, si))
    };
    let mut owner: Vec<Vec<Option<u32>>> =
        p.clients.iter().map(|(_, s)| vec![None; s.len()]).collect();
    const ON_STACK: u32 = u32::MAX;
    for ci in 0..p.clients.len() {
        for si in 0..p.clients[ci].1.len() {
            if owner[ci][si].is_some() {
                continue;
            }
            let mut stack = vec![(ci, si)];
            while let Some(&(c, s)) = stack.last() {
                if owner[c][s].is_some_and(|o| o != ON_STACK) {
                    stack.pop();
                    continue;
                }
                let st = &p.clients[c].1[s];
                // Some(Ok(part)) resolved here; Some(Err(dep)) wait for dep.
                let step: Result<u32, (usize, usize)> = if st.kind != Kind::Item {
                    Ok(0)
                } else if let Some((part, _)) = outside.owner(Id {
                    client: p.clients[c].0,
                    clock: st.clock,
                }) {
                    Ok(intern(part, &mut parts))
                } else {
                    let dep = match &st.parent {
                        Parent::Named(name) => {
                            let text = |(a, b): (usize, usize)| {
                                std::str::from_utf8(&p.buf[a..b]).unwrap_or("")
                            };
                            let k = st
                                .sub
                                .filter(|_| splitting)
                                .and_then(|k| part_key(text(*name), text(k)));
                            Err(k)
                        }
                        Parent::Id(id) => Ok(*id),
                        Parent::Inferred => match st.origin.or(st.right) {
                            Some(id) => Ok(id),
                            None => Err(None),
                        },
                    };
                    match dep {
                        Err(Some(k)) => Ok(intern(&k, &mut parts)),
                        Err(None) => Ok(0),
                        Ok(id) => match find(id) {
                            Some((dc, ds)) => match owner[dc][ds] {
                                Some(ON_STACK) => Ok(0), // a cycle: malformed, main
                                Some(o) => Ok(o),
                                None => Err((dc, ds)),
                            },
                            None => Ok(outside.owner(id).map_or(0, |(k, _)| intern(k, &mut parts))),
                        },
                    }
                };
                match step {
                    Ok(o) => {
                        owner[c][s] = Some(o);
                        stack.pop();
                    }
                    Err(dep) => {
                        owner[c][s] = Some(ON_STACK);
                        stack.push(dep);
                    }
                }
            }
        }
    }
    // Entries left ON_STACK were waiting on a resolved dependency: settle them in stack order
    // (the loop above pops only once resolved, so none are left).
    Classes { parts, owner }
}

// ---- split -----------------------------------------------------------------------------------

/// A whole document cut into parts: every part as a full v1 update (MAIN always present).
#[derive(Debug, Default)]
pub struct Split {
    pub parts: BTreeMap<PartKey, Vec<u8>>,
    pub owners: OwnerIndex,
}

/// Cuts a full-state v1 update into the main document and one part per heavy block. Every
/// part carries every client's whole clock range (fillers where another part owns it), so all
/// parts start with the original state vector.
pub fn split(update: &[u8]) -> Result<Split, Error> {
    let p = parse(update)?;
    let classes = classify(&p, &NoOwners, true);
    let mut owners = OwnerIndex::default();
    // Owned item ranges per part and client (normalised), for the delete sets.
    let mut owned: Vec<HashMap<u64, Vec<(u32, u32)>>> = vec![HashMap::new(); classes.parts.len()];
    let mut gc: HashMap<u64, Vec<(u32, u32)>> = HashMap::new();
    for (ci, (client, structs)) in p.clients.iter().enumerate() {
        for (si, s) in structs.iter().enumerate() {
            match s.kind {
                Kind::Item => {
                    let o = classes.owner[ci][si].unwrap_or(0) as usize;
                    owners.record(*client, s.clock, s.end(), &classes.parts[o]);
                    owned[o]
                        .entry(*client)
                        .or_default()
                        .push((s.clock, s.end()));
                }
                Kind::Gc => gc.entry(*client).or_default().push((s.clock, s.end())),
                Kind::Skip => {}
            }
        }
    }
    for m in owned.iter_mut().chain(std::iter::once(&mut gc)) {
        for r in m.values_mut() {
            normalise(r);
        }
    }
    let mut parts = BTreeMap::new();
    for (pi, key) in classes.parts.iter().enumerate() {
        let mut out = Vec::new();
        put_var(&mut out, p.clients.len() as u64);
        for (ci, (client, structs)) in p.clients.iter().enumerate() {
            let mut pieces = Vec::new();
            for (si, s) in structs.iter().enumerate() {
                let mine = match s.kind {
                    Kind::Item => classes.owner[ci][si] == Some(pi as u32),
                    Kind::Gc => pi == 0,
                    Kind::Skip => false,
                };
                if mine {
                    push_piece(&mut pieces, Piece::Raw(p.raw(s)));
                } else if s.kind == Kind::Skip {
                    push_piece(&mut pieces, Piece::Skip(s.len));
                } else {
                    push_piece(&mut pieces, Piece::Gc(s.len));
                }
            }
            let start = structs.first().map_or(0, |s| s.clock);
            write_client(&mut out, *client, start, &pieces);
        }
        let mut ds = BTreeMap::new();
        for (client, ranges) in &p.ds {
            let mut mine = owned[pi].get(client).cloned().unwrap_or_default();
            if pi == 0 {
                mine.extend(gc.get(client).into_iter().flatten().copied());
                normalise(&mut mine);
            }
            let mut r = ranges.clone();
            normalise(&mut r);
            let cut = intersect(&r, &mine);
            if !cut.is_empty() {
                ds.insert(*client, cut);
            }
        }
        write_ds(&mut out, &ds);
        parts.insert(key.clone(), out);
    }
    Ok(Split { parts, owners })
}

// ---- flatten ---------------------------------------------------------------------------------

/// Merges parts (full states or not) back into one v1 update: each clock range from the part
/// that owns an item there, GC where nobody does, Skip where no part has the range. Item bytes
/// are copied as they are, so a [`split`] flattens back to the original struct section.
pub fn flatten<B: AsRef<[u8]>>(parts: &[B]) -> Result<Vec<u8>, Error> {
    let parsed: Vec<Parsed> = parts
        .iter()
        .map(|b| parse(b.as_ref()))
        .collect::<Result<_, _>>()?;
    // client → (items (clock, end, part, struct ref), covered ranges)
    struct Client<'a> {
        items: Vec<(u32, u32, &'a [u8], usize)>,
        cover: Vec<(u32, u32)>,
        /// GC struct boundaries in any part: yrs does not always squash adjacent GC, and
        /// keeping its boundaries keeps the struct bytes of an untouched split identical.
        cuts: std::collections::BTreeSet<u32>,
    }
    let mut clients: BTreeMap<u64, Client> = BTreeMap::new();
    for (pi, p) in parsed.iter().enumerate() {
        for (client, structs) in &p.clients {
            let c = clients.entry(*client).or_insert_with(|| Client {
                items: Vec::new(),
                cover: Vec::new(),
                cuts: Default::default(),
            });
            for s in structs {
                match s.kind {
                    Kind::Item => {
                        c.items.push((s.clock, s.end(), p.raw(s), pi));
                        c.cover.push((s.clock, s.end()));
                    }
                    Kind::Gc => {
                        c.cover.push((s.clock, s.end()));
                        c.cuts.insert(s.clock);
                        c.cuts.insert(s.end());
                    }
                    Kind::Skip => {}
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut ds: BTreeMap<u64, Vec<(u32, u32)>> = BTreeMap::new();
    let mut owned_by: Vec<HashMap<u64, Vec<(u32, u32)>>> = vec![HashMap::new(); parsed.len()];
    let mut sections: Vec<(u64, u32, Vec<Piece>)> = Vec::new();
    for (client, c) in clients.iter_mut().rev() {
        c.items.sort_by_key(|i| (i.0, i.1));
        c.items
            .dedup_by(|b, a| a.0 == b.0 && a.1 == b.1 && a.2 == b.2);
        normalise(&mut c.cover);
        let Some(&(start, _)) = c.cover.first() else {
            continue;
        };
        let mut pieces = Vec::new();
        let mut at = start;
        let mut cover = c.cover.iter().peekable();
        let cuts = &c.cuts;
        let mut fill = |from: u32, to: u32, pieces: &mut Vec<Piece>, ds: &mut Vec<(u32, u32)>| {
            // GC where some part covers [from, to), Skip elsewhere.
            let mut x = from;
            while x < to {
                while cover.peek().is_some_and(|r| r.1 <= x) {
                    cover.next();
                }
                match cover.peek() {
                    Some(&&(a, b)) if a <= x => {
                        let e = b.min(to);
                        let mut y = x;
                        for &cut in cuts.range(x + 1..e).chain(std::iter::once(&e)) {
                            pieces.push(Piece::Gc(cut - y));
                            y = cut;
                        }
                        ds.push((x, e));
                        x = e;
                    }
                    Some(&&(a, _)) => {
                        let e = a.min(to);
                        push_piece(pieces, Piece::Skip(e - x));
                        x = e;
                    }
                    None => {
                        push_piece(pieces, Piece::Skip(to - x));
                        x = to;
                    }
                }
            }
        };
        let deleted = ds.entry(*client).or_default();
        for &(a, b, raw, pi) in &c.items {
            if a < at {
                return Err(Error::Clash {
                    client: *client,
                    clock: a,
                });
            }
            if a > at {
                fill(at, a, &mut pieces, deleted);
            }
            pieces.push(Piece::Raw(raw));
            owned_by[pi].entry(*client).or_default().push((a, b));
            at = b;
        }
        let end = c.cover.last().map_or(at, |r| r.1);
        if end > at {
            fill(at, end, &mut pieces, deleted);
        }
        // A trailing Skip carries nothing.
        while matches!(pieces.last(), Some(Piece::Skip(_))) {
            pieces.pop();
        }
        sections.push((*client, start, pieces));
    }
    put_var(&mut out, sections.len() as u64);
    for (client, start, pieces) in &sections {
        write_client(&mut out, *client, *start, pieces);
    }
    for (pi, p) in parsed.iter().enumerate() {
        for (client, ranges) in &p.ds {
            let Some(mine) = owned_by[pi].get_mut(client) else {
                continue;
            };
            normalise(mine);
            let mut r = ranges.clone();
            normalise(&mut r);
            ds.entry(*client).or_default().extend(intersect(&r, mine));
        }
    }
    for r in ds.values_mut() {
        normalise(r);
    }
    write_ds(&mut out, &ds);
    Ok(out)
}

// ---- route -----------------------------------------------------------------------------------

/// An incremental update cut by owner.
#[derive(Debug, Default)]
pub struct Routed {
    /// Each touched part's share, prefixed with the fillers the part lacks.
    pub parts: BTreeMap<PartKey, Vec<u8>>,
    /// `(client, start, end, part)` for every item, to record in the room's [`OwnerIndex`].
    pub owned: Vec<(u64, u32, u32, PartKey)>,
}

/// Cuts an incremental update (made on a whole view, or arriving for one) into per-part
/// updates. `state(part, client)` is that part's current clock for the client: a part that
/// gets items of a client is first given fillers from there, so it never has a gap. A part gets
/// nothing unless it owns an item or a deletion in the update; the main document always gets
/// every client's range. New items inherit an existing parent's owner or stay in main until
/// the next split.
pub fn route(
    update: &[u8],
    owners: &dyn Owners,
    state: &dyn Fn(&str, u64) -> u32,
) -> Result<Routed, Error> {
    route_with(update, owners, state, MAIN)
}

/// A main-document update made against the main document as a client holds it, before it
/// meets the whole canvas: the client's main document has GC fillers where parts own items, and
/// its delete set names them. Deletions of a part's items are kept only when the update also
/// writes items into that part (an editor still editing a block that the last split moved into
/// a part); everything else of the update is kept as it is.
pub fn main_share(update: &[u8], owners: &dyn Owners) -> Result<Vec<u8>, Error> {
    let routed = route(update, owners, &|_, _| u32::MAX)?;
    let writes: std::collections::HashSet<&str> =
        routed.owned.iter().map(|(_, _, _, k)| k.as_str()).collect();
    let mut out = struct_section(update)?.to_vec();
    let mut deletes = BTreeMap::new();
    for (key, share) in routed.parts {
        if key.is_empty() || writes.contains(key.as_str()) {
            for (client, ranges) in delete_set(&share)? {
                deletes
                    .entry(client)
                    .or_insert_with(Vec::new)
                    .extend(ranges);
            }
        }
    }
    for ranges in deletes.values_mut() {
        normalise(ranges);
    }
    write_ds(&mut out, &deletes);
    Ok(out)
}

/// What an update made on part `part` may change in any other document: its own items, the
/// deletions of items it owns, and every client's clock range (fillers elsewhere). yrs encodes a
/// document's GC structs in its delete set, so a part's update names its fillers as deleted;
/// applied as it is to the whole canvas (a whole view, a flattened copy) it would delete every
/// other part's items. Every update that comes from a part goes through this before it reaches
/// anything but that part.
pub fn own_share(update: &[u8], part: &str, owners: &dyn Owners) -> Result<Vec<u8>, Error> {
    let routed = route_with(update, owners, &|_, _| u32::MAX, part)?;
    Ok(routed
        .parts
        .get(part)
        .cloned()
        .unwrap_or_else(|| vec![0, 0]))
}

/// [`route`], with `full` (rather than the main document) getting every client's range.
fn route_with(
    update: &[u8],
    owners: &dyn Owners,
    state: &dyn Fn(&str, u64) -> u32,
    full: &str,
) -> Result<Routed, Error> {
    let p = parse(update)?;
    let classes = classify(&p, owners, false);
    let mut items_of: BTreeMap<u32, HashMap<u64, bool>> = BTreeMap::new();
    let mut owned = Vec::new();
    for (ci, (client, structs)) in p.clients.iter().enumerate() {
        for (si, s) in structs.iter().enumerate() {
            if s.kind == Kind::Item {
                let o = classes.owner[ci][si].unwrap_or(0);
                items_of.entry(o).or_default().insert(*client, true);
                owned.push((*client, s.clock, s.end(), classes.parts[o as usize].clone()));
            }
        }
    }
    // Deletions by owner: inside the update by its classes, outside by the index.
    let mut dels: BTreeMap<String, BTreeMap<u64, Vec<(u32, u32)>>> = BTreeMap::new();
    let in_update: HashMap<u64, usize> = p
        .clients
        .iter()
        .enumerate()
        .map(|(i, (c, _))| (*c, i))
        .collect();
    for (client, ranges) in &p.ds {
        for &(a, b) in ranges {
            let mut x = a;
            while x < b {
                let local = in_update.get(client).and_then(|&ci| {
                    let structs = &p.clients[ci].1;
                    let si = structs.partition_point(|s| s.end() <= x);
                    (si < structs.len() && structs[si].clock <= x).then_some((ci, si))
                });
                // An explicit GC struct is already deleted in every part. A deletion outside
                // the update uses the index and falls back to main for unassigned clocks.
                let (part, end) = match local {
                    Some((ci, si)) => {
                        let s = &p.clients[ci].1[si];
                        let part = (s.kind == Kind::Item).then(|| {
                            classes.parts[classes.owner[ci][si].unwrap_or(0) as usize].clone()
                        });
                        (part, s.end())
                    }
                    None => match owners.owner(Id {
                        client: *client,
                        clock: x,
                    }) {
                        Some((k, end)) => (Some(k.to_string()), end),
                        None => {
                            let next = in_update
                                .get(client)
                                .and_then(|&ci| {
                                    p.clients[ci].1.iter().map(|s| s.clock).find(|&c| c > x)
                                })
                                .unwrap_or(b);
                            // The next owned range, if the index knows one before `next`.
                            let owned = (x + 1..next).find(|&c| {
                                owners
                                    .owner(Id {
                                        client: *client,
                                        clock: c,
                                    })
                                    .is_some()
                            });
                            (Some(MAIN.to_string()), owned.unwrap_or(next))
                        }
                    },
                };
                let e = end.min(b).max(x + 1);
                if let Some(part) = part {
                    dels.entry(part)
                        .or_default()
                        .entry(*client)
                        .or_default()
                        .push((x, e));
                }
                x = e;
            }
        }
    }
    let mut touched: Vec<String> = items_of
        .keys()
        .map(|&o| classes.parts[o as usize].clone())
        .collect();
    touched.extend(dels.keys().cloned());
    // The main document gets every client's range (fillers where it owns nothing), so the
    // parts together always cover every clock: a range that is all GC (inserted and collected
    // before it was routed) would otherwise be nowhere, and the flatten's state vector short.
    touched.push(full.to_string());
    touched.sort();
    touched.dedup();
    let mut parts = BTreeMap::new();
    for key in touched {
        let pi = classes
            .parts
            .iter()
            .position(|k| *k == key)
            .map(|i| i as u32);
        let mine = pi.and_then(|i| items_of.get(&i));
        let mut out = Vec::new();
        let mut sections = Vec::new();
        for (ci, (client, structs)) in p.clients.iter().enumerate() {
            if !(key == full || mine.is_some_and(|m| m.contains_key(client))) {
                continue;
            }
            let first = structs.first().map_or(0, |s| s.clock);
            let have = state(&key, *client);
            let mut pieces = Vec::new();
            let start = have.min(first);
            if have < first {
                push_piece(&mut pieces, Piece::Gc(first - have));
            }
            for (si, s) in structs.iter().enumerate() {
                if s.kind == Kind::Item && classes.owner[ci][si] == pi {
                    pieces.push(Piece::Raw(p.raw(s)));
                } else if s.kind == Kind::Skip {
                    push_piece(&mut pieces, Piece::Skip(s.len));
                } else {
                    push_piece(&mut pieces, Piece::Gc(s.len));
                }
            }
            sections.push((*client, start, pieces));
        }
        put_var(&mut out, sections.len() as u64);
        for (client, start, pieces) in &sections {
            write_client(&mut out, *client, *start, pieces);
        }
        let mut ds = dels.remove(&key).unwrap_or_default();
        for r in ds.values_mut() {
            normalise(r);
        }
        write_ds(&mut out, &ds);
        parts.insert(key, out);
    }
    Ok(Routed { parts, owned })
}

/// The state vector of a v1 update as `client → end of its contiguous range` (fillers count).
pub fn update_state(update: &[u8]) -> Result<HashMap<u64, u32>, Error> {
    let p = parse(update)?;
    Ok(p.clients
        .iter()
        .filter_map(|(c, s)| {
            s.iter()
                .rev()
                .find(|s| s.kind != Kind::Skip)
                .map(|s| (*c, s.end()))
        })
        .collect())
}

/// The struct section of a v1 update (the bytes before the delete set), for byte comparisons.
pub fn struct_section(update: &[u8]) -> Result<&[u8], Error> {
    let p = parse(update)?;
    let end = p
        .clients
        .iter()
        .flat_map(|(_, s)| s.last())
        .map(|s| s.raw.1)
        .max()
        .unwrap_or(1);
    Ok(&update[..end])
}

/// The delete set of a v1 update, normalised per client.
pub fn delete_set(update: &[u8]) -> Result<BTreeMap<u64, Vec<(u32, u32)>>, Error> {
    let p = parse(update)?;
    let mut out: BTreeMap<u64, Vec<(u32, u32)>> = BTreeMap::new();
    for (c, r) in p.ds {
        out.entry(c).or_default().extend(r);
    }
    for r in out.values_mut() {
        normalise(r);
    }
    out.retain(|_, r| !r.is_empty());
    Ok(out)
}

#[cfg(test)]
#[path = "parts_tests.rs"]
mod tests;
