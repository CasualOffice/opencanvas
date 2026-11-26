// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! A1 references ⇄ stored references (ADR-080 §3, SHEET-02).
//!
//! What people type and see is Excel's A1 notation: `B2`, `$B$2`, `B2:C9`, `A:A`, `1:3`,
//! `Rates!B3`, `'Q1 plan'!A1`. What the Yjs document stores is the same formula with every
//! reference replaced by a token naming the row and column *ids* (and the sheet id when one was
//! written), between U+E000 and U+E001:
//!
//! ```text
//! =SUM(B2:B9)*$A$1   →   =SUM(\u{E000}c<colB>;r<row2>;:c<colB>;r<row9>;\u{E001})*\u{E000}c$<colA>;r$<row1>;\u{E001}
//! ```
//!
//! Inserting a row is then an insert into the sheet's row list and every formula keeps pointing
//! at the same cells; deleting one makes the references to it read `#REF!`. A sheet's grid has a
//! fixed size (rows and columns are added explicitly, as in Google Sheets), so every in-grid
//! reference has ids. A reference outside the grid, to a sheet that does not exist, or in a 3-D
//! form (`Sheet1:Sheet3!A1`) is kept as typed. Text in string literals and in structured
//! references (`Table1[Col]`) is never touched.
//!
//! Ids are opaque but must not contain `$ ; : !` or the two delimiters.

/// Opens a stored reference.
pub const OPEN: char = '\u{E000}';
/// Closes a stored reference.
pub const CLOSE: char = '\u{E001}';
/// Excel's grid limits.
pub const MAX_ROWS: u32 = 1_048_576;
pub const MAX_COLS: u32 = 16_384;
/// What a reference to a deleted row, column or sheet reads.
pub const REF_ERR: &str = "#REF!";

/// The current order of a block's sheets, rows and columns (from the Yjs document).
pub trait Grid {
    /// A sheet's id from its name (Excel compares names without case).
    fn sheet_by_name(&self, name: &str) -> Option<String>;
    /// A sheet's current name.
    fn sheet_name(&self, sheet: &str) -> Option<String>;
    /// The id of the row at a zero-based index (`None` outside the grid).
    fn row_id(&self, sheet: &str, index: u32) -> Option<String>;
    /// The id of the column at a zero-based index (`None` outside the grid).
    fn col_id(&self, sheet: &str, index: u32) -> Option<String>;
    /// Where a row id is now (`None` once deleted).
    fn row_index(&self, sheet: &str, id: &str) -> Option<u32>;
    /// Where a column id is now (`None` once deleted).
    fn col_index(&self, sheet: &str, id: &str) -> Option<u32>;
}

/// One axis of an endpoint: a zero-based index and whether it is absolute (`$`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Axis {
    pub index: u32,
    pub abs: bool,
}

/// One end of a reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    Cell {
        col: Axis,
        row: Axis,
    },
    /// A whole column (`A` in `A:C`).
    Col(Axis),
    /// A whole row (`1` in `1:3`).
    Row(Axis),
}

/// A reference as written: an optional sheet name (unquoted), one end, and a second for a range.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ref {
    pub sheet: Option<String>,
    pub a: End,
    pub b: Option<End>,
}

/// A formula cut into text and references (`span` is the reference's source text).
#[derive(Debug, PartialEq, Eq)]
pub enum Piece<'a> {
    Text(&'a str),
    Ref { r: Ref, span: &'a str },
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '.'
}

/// Column letters (`A`, `Z`, `AA`, `XFD`) for a zero-based index.
pub fn col_letters(mut index: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

fn letters_index(s: &str) -> Option<u32> {
    let mut n: u32 = 0;
    for b in s.bytes() {
        n = n
            .checked_mul(26)?
            .checked_add((b.to_ascii_uppercase() - b'A' + 1) as u32)?;
    }
    n.checked_sub(1).filter(|&i| i < MAX_COLS)
}

/// Parses one end at the start of `s`: returns it and the bytes used.
fn parse_end(s: &str) -> Option<(End, usize)> {
    let b = s.as_bytes();
    let mut p = 0;
    let first_abs = b.first() == Some(&b'$');
    p += first_abs as usize;
    let ls = p;
    while p < b.len() && b[p].is_ascii_alphabetic() {
        p += 1;
    }
    let nl = p - ls;
    if nl > 3 {
        return None;
    }
    let digits = |from: usize| -> Option<(u32, usize)> {
        let mut q = from;
        while q < b.len() && b[q].is_ascii_digit() {
            q += 1;
        }
        if q == from || b[from] == b'0' || q - from > 7 {
            return None;
        }
        let n: u32 = s[from..q].parse().ok()?;
        (1..=MAX_ROWS).contains(&n).then_some((n - 1, q))
    };
    if nl > 0 {
        let col = Axis {
            index: letters_index(&s[ls..p])?,
            abs: first_abs,
        };
        let row_abs = b.get(p) == Some(&b'$');
        match digits(p + row_abs as usize) {
            Some((row, q)) => Some((
                End::Cell {
                    col,
                    row: Axis {
                        index: row,
                        abs: row_abs,
                    },
                },
                q,
            )),
            None if !row_abs => Some((End::Col(col), p)),
            None => None,
        }
    } else {
        let (row, q) = digits(p)?;
        Some((
            End::Row(Axis {
                index: row,
                abs: first_abs,
            }),
            q,
        ))
    }
}

/// `Name!` or `'Quoted ''name'''!` at the start of `s`: the name and the bytes used.
fn parse_sheet(s: &str) -> Option<(String, usize)> {
    if let Some(rest) = s.strip_prefix('\'') {
        let mut name = String::new();
        let mut it = rest.char_indices().peekable();
        while let Some((i, c)) = it.next() {
            if c == '\'' {
                if let Some(&(_, '\'')) = it.peek() {
                    name.push('\'');
                    it.next();
                    continue;
                }
                let after = 1 + i + 1;
                return (s[after..].starts_with('!') && !name.is_empty())
                    .then(|| (name, after + 1));
            }
            name.push(c);
        }
        return None;
    }
    let end = s.find(|c: char| !is_ident(c)).unwrap_or(s.len());
    (end > 0 && s[end..].starts_with('!')).then(|| (s[..end].to_string(), end + 1))
}

fn same_kind(a: &End, b: &End) -> bool {
    matches!(
        (a, b),
        (End::Cell { .. }, End::Cell { .. })
            | (End::Col(_), End::Col(_))
            | (End::Row(_), End::Row(_))
    )
}

/// A reference starting at `s`, with the bytes it uses.
fn parse_ref(s: &str) -> Option<(Ref, usize)> {
    let (sheet, j) = match parse_sheet(s) {
        Some((n, j)) => (Some(n), j),
        None => (None, 0),
    };
    let (a, mut k) = parse_end(&s[j..]).map(|(e, n)| (e, j + n))?;
    let mut b = None;
    if s[k..].starts_with(':')
        && let Some((e, n)) = parse_end(&s[k + 1..])
        && same_kind(&a, &e)
    {
        b = Some(e);
        k += 1 + n;
    }
    if b.is_none() && !matches!(a, End::Cell { .. }) {
        return None;
    }
    // `LOG10(`, `A1B`, `A1.x`, `A1!`: not a reference.
    if s[k..].starts_with(|c: char| is_ident(c) || matches!(c, '(' | '!' | '$' | '\'')) {
        return None;
    }
    Some((Ref { sheet, a, b }, k))
}

/// Skips a string literal (`""` escapes a quote) starting at `i`; returns the index after it.
fn skip_string(s: &str, i: usize) -> usize {
    let b = s.as_bytes();
    let mut p = i + 1;
    while p < b.len() {
        if b[p] == b'"' {
            if b.get(p + 1) == Some(&b'"') {
                p += 2;
                continue;
            }
            return p + 1;
        }
        p += 1;
    }
    b.len()
}

/// Skips `[...]` (structured references, nested once as in `Table1[[#This Row],[Col]]`).
fn skip_brackets(s: &str, i: usize) -> usize {
    let mut depth = 0usize;
    for (k, c) in s[i..].char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return i + k + 1;
                }
            }
            _ => {}
        }
    }
    s.len()
}

/// Cuts an A1 formula into text and references.
pub fn scan(src: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut text = 0;
    let mut i = 0;
    while i < src.len() {
        let c = src[i..].chars().next().expect("in bounds");
        match c {
            '"' => {
                i = skip_string(src, i);
                continue;
            }
            '[' => {
                i = skip_brackets(src, i);
                continue;
            }
            OPEN => {
                i = src[i..]
                    .find(CLOSE)
                    .map_or(src.len(), |k| i + k + CLOSE.len_utf8());
                continue;
            }
            _ => {}
        }
        let prev = src[..i].chars().next_back();
        // Not inside a name, not after a sheet (`!`), and not the second sheet of a 3-D form.
        let boundary =
            !matches!(prev, Some(p) if is_ident(p) || matches!(p, '$' | '\'' | '!' | ':'));
        if boundary
            && (c == '$' || c == '\'' || is_ident(c))
            && let Some((r, n)) = parse_ref(&src[i..])
        {
            if text < i {
                out.push(Piece::Text(&src[text..i]));
            }
            out.push(Piece::Ref {
                r,
                span: &src[i..i + n],
            });
            i += n;
            text = i;
            continue;
        }
        i += c.len_utf8();
    }
    if text < src.len() {
        out.push(Piece::Text(&src[text..]));
    }
    out
}

/// A sheet name as a formula writes it: quoted when it is not a plain name or could be read as a
/// reference.
pub fn sheet_prefix(name: &str) -> String {
    let plain = !name.is_empty()
        && name.chars().all(is_ident)
        && !name.starts_with(|c: char| c.is_ascii_digit() || c == '.')
        && parse_end(name).is_none_or(|(_, n)| n != name.len());
    if plain {
        format!("{name}!")
    } else {
        format!("'{}'!", name.replace('\'', "''"))
    }
}

fn fmt_end(e: &End, out: &mut String) {
    let ax = |a: &Axis, out: &mut String| {
        if a.abs {
            out.push('$');
        }
    };
    match e {
        End::Cell { col, row } => {
            ax(col, out);
            out.push_str(&col_letters(col.index));
            ax(row, out);
            out.push_str(&(row.index + 1).to_string());
        }
        End::Col(c) => {
            ax(c, out);
            out.push_str(&col_letters(c.index));
        }
        End::Row(r) => {
            ax(r, out);
            out.push_str(&(r.index + 1).to_string());
        }
    }
}

/// A reference in A1 (canonical: upper-case letters, names quoted only when needed).
pub fn fmt_ref(r: &Ref) -> String {
    let mut out = r.sheet.as_deref().map(sheet_prefix).unwrap_or_default();
    fmt_end(&r.a, &mut out);
    if let Some(b) = &r.b {
        out.push(':');
        fmt_end(b, &mut out);
    }
    out
}

/// One end with ids instead of indices (`None` when part of it is outside the grid).
fn end_ids(e: &End, sheet: &str, grid: &impl Grid) -> Option<String> {
    let mut out = String::new();
    let mut put = |tag: char, a: &Axis, id: String| {
        out.push(tag);
        if a.abs {
            out.push('$');
        }
        out.push_str(&id);
        out.push(';');
    };
    match e {
        End::Cell { col, row } => {
            put('c', col, grid.col_id(sheet, col.index)?);
            put('r', row, grid.row_id(sheet, row.index)?);
        }
        End::Col(c) => put('c', c, grid.col_id(sheet, c.index)?),
        End::Row(r) => put('r', r, grid.row_id(sheet, r.index)?),
    }
    Some(out)
}

/// An A1 formula (`=…`) as stored: references become id tokens. `here` is the formula's sheet id.
/// Input that is not a formula is returned as it is.
pub fn to_ids(src: &str, here: &str, grid: &impl Grid) -> String {
    if !src.starts_with('=') {
        return src.to_string();
    }
    let mut out = String::with_capacity(src.len() + 16);
    for piece in scan(src) {
        match piece {
            Piece::Text(t) => out.push_str(t),
            Piece::Ref { r, span } => {
                let sheet = match &r.sheet {
                    Some(name) => grid.sheet_by_name(name),
                    None => Some(here.to_string()),
                };
                let token = sheet.and_then(|sid| {
                    let a = end_ids(&r.a, &sid, grid)?;
                    let b = match &r.b {
                        Some(b) => Some(end_ids(b, &sid, grid)?),
                        None => None,
                    };
                    let mut t = String::new();
                    t.push(OPEN);
                    if r.sheet.is_some() {
                        t.push('s');
                        t.push_str(&sid);
                        t.push('!');
                    }
                    t.push_str(&a);
                    if let Some(b) = b {
                        t.push(':');
                        t.push_str(&b);
                    }
                    t.push(CLOSE);
                    Some(t)
                });
                // Outside the grid, an unknown sheet: kept as typed.
                out.push_str(token.as_deref().unwrap_or(span));
            }
        }
    }
    out
}

/// One stored axis: whether it is absolute, and its id.
type IdAxis<'a> = Option<(bool, &'a str)>;
/// One stored end: its column and row parts.
type IdEnd<'a> = (IdAxis<'a>, IdAxis<'a>);

/// Reads `c[$]id;` / `r[$]id;` parts of one end; returns `(col, row)` and the bytes used.
fn read_end(s: &str) -> Option<(IdEnd<'_>, usize)> {
    let mut col = None;
    let mut row = None;
    let mut p = 0;
    while let Some(tag) = s[p..].chars().next().filter(|c| matches!(c, 'c' | 'r')) {
        let rest = &s[p + 1..];
        let abs = rest.starts_with('$');
        let body = &rest[abs as usize..];
        let semi = body.find(';')?;
        let id = &body[..semi];
        if tag == 'c' {
            col = Some((abs, id))
        } else {
            row = Some((abs, id))
        }
        p += 1 + abs as usize + semi + 1;
    }
    (p > 0).then_some(((col, row), p))
}

fn resolve(parts: IdEnd<'_>, sheet: &str, grid: &impl Grid) -> Option<End> {
    let col = |(abs, id): (bool, &str)| grid.col_index(sheet, id).map(|index| Axis { index, abs });
    let row = |(abs, id): (bool, &str)| grid.row_index(sheet, id).map(|index| Axis { index, abs });
    Some(match parts {
        (Some(c), Some(r)) => End::Cell {
            col: col(c)?,
            row: row(r)?,
        },
        (Some(c), None) => End::Col(col(c)?),
        (None, Some(r)) => End::Row(row(r)?),
        (None, None) => return None,
    })
}

/// One stored token's body as A1 (`#REF!` when a row, column or sheet it names is gone).
fn token_a1(body: &str, here: &str, grid: &impl Grid) -> String {
    let (sheet, rest, named) = match body.strip_prefix('s').and_then(|b| b.split_once('!')) {
        Some((sid, rest)) => (sid.to_string(), rest, true),
        None => (here.to_string(), body, false),
    };
    let out = (|| {
        let name = if named {
            Some(grid.sheet_name(&sheet)?)
        } else {
            None
        };
        let (pa, n) = read_end(rest)?;
        let a = resolve(pa, &sheet, grid)?;
        let b = match rest[n..].strip_prefix(':') {
            Some(r2) => Some(resolve(read_end(r2)?.0, &sheet, grid)?),
            None => None,
        };
        Some(fmt_ref(&Ref { sheet: name, a, b }))
    })();
    out.unwrap_or_else(|| REF_ERR.to_string())
}

/// A stored formula as A1, from the grid's current order. `here` is the formula's sheet id.
pub fn to_a1(stored: &str, here: &str, grid: &impl Grid) -> String {
    let mut out = String::with_capacity(stored.len());
    let mut rest = stored;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        let after = &rest[i + OPEN.len_utf8()..];
        match after.find(CLOSE) {
            Some(j) => {
                out.push_str(&token_a1(&after[..j], here, grid));
                rest = &after[j + CLOSE.len_utf8()..];
            }
            None => {
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn shift_axis(a: Axis, d: i64, max: u32) -> Option<Axis> {
    if a.abs {
        return Some(a);
    }
    let n = a.index as i64 + d;
    (0..max as i64).contains(&n).then_some(Axis {
        index: n as u32,
        abs: false,
    })
}

fn shift_end(e: &End, dr: i64, dc: i64) -> Option<End> {
    Some(match *e {
        End::Cell { col, row } => End::Cell {
            col: shift_axis(col, dc, MAX_COLS)?,
            row: shift_axis(row, dr, MAX_ROWS)?,
        },
        End::Col(c) => End::Col(shift_axis(c, dc, MAX_COLS)?),
        End::Row(r) => End::Row(shift_axis(r, dr, MAX_ROWS)?),
    })
}

/// An A1 formula copied `dr` rows and `dc` columns away (fill handle, paste): relative parts move,
/// `$` parts stay, and a reference pushed off the grid becomes `#REF!`.
pub fn shift(src: &str, dr: i64, dc: i64) -> String {
    if !src.starts_with('=') {
        return src.to_string();
    }
    let mut out = String::with_capacity(src.len());
    for piece in scan(src) {
        match piece {
            Piece::Text(t) => out.push_str(t),
            Piece::Ref { r, .. } => {
                let moved = (|| {
                    let a = shift_end(&r.a, dr, dc)?;
                    let b = match &r.b {
                        Some(b) => Some(shift_end(b, dr, dc)?),
                        None => None,
                    };
                    Some(fmt_ref(&Ref {
                        sheet: r.sheet.clone(),
                        a,
                        b,
                    }))
                })();
                out.push_str(moved.as_deref().unwrap_or(REF_ERR));
            }
        }
    }
    out
}

/// A grid held in memory: the server builds one from the Yjs document; tests use it directly.
#[derive(Clone, Debug, Default)]
pub struct MemGrid {
    /// `(id, name, row ids, column ids)` in tab order.
    pub sheets: Vec<(String, String, Vec<String>, Vec<String>)>,
}

impl MemGrid {
    fn sheet(&self, id: &str) -> Option<&(String, String, Vec<String>, Vec<String>)> {
        self.sheets.iter().find(|s| s.0 == id)
    }
}

impl Grid for MemGrid {
    fn sheet_by_name(&self, name: &str) -> Option<String> {
        self.sheets
            .iter()
            .find(|s| s.1.to_lowercase() == name.to_lowercase())
            .map(|s| s.0.clone())
    }
    fn sheet_name(&self, sheet: &str) -> Option<String> {
        self.sheet(sheet).map(|s| s.1.clone())
    }
    fn row_id(&self, sheet: &str, index: u32) -> Option<String> {
        self.sheet(sheet)?.2.get(index as usize).cloned()
    }
    fn col_id(&self, sheet: &str, index: u32) -> Option<String> {
        self.sheet(sheet)?.3.get(index as usize).cloned()
    }
    fn row_index(&self, sheet: &str, id: &str) -> Option<u32> {
        self.sheet(sheet)?
            .2
            .iter()
            .position(|x| x == id)
            .map(|i| i as u32)
    }
    fn col_index(&self, sheet: &str, id: &str) -> Option<u32> {
        self.sheet(sheet)?
            .3
            .iter()
            .position(|x| x == id)
            .map(|i| i as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> MemGrid {
        let ids = |p: &str, n: usize| (0..n).map(|i| format!("{p}{i}")).collect::<Vec<_>>();
        MemGrid {
            sheets: vec![
                ("s1".into(), "Budget".into(), ids("r", 100), ids("c", 26)),
                ("s2".into(), "Rates".into(), ids("q", 20), ids("d", 10)),
                ("s3".into(), "Q1 plan".into(), ids("p", 10), ids("e", 5)),
            ],
        }
    }

    fn round(src: &str) -> String {
        let g = grid();
        to_a1(&to_ids(src, "s1", &g), "s1", &g)
    }

    #[test]
    fn letters() {
        assert_eq!(col_letters(0), "A");
        assert_eq!(col_letters(25), "Z");
        assert_eq!(col_letters(26), "AA");
        assert_eq!(col_letters(16_383), "XFD");
        assert_eq!(letters_index("XFD"), Some(16_383));
        assert_eq!(letters_index("XFE"), None);
    }

    #[test]
    fn the_prototype_formulas_round_trip() {
        for f in [
            "=SUM(B2:B9)",
            "=$A$1*2",
            "=Rates!B3*C4",
            "='Q1 plan'!A:A",
            "=SUM(1:3)",
            "=IF(A3>25,\"big\",\"small\")",
            "=VLOOKUP(3,Rates!$A$1:$B$10,2,FALSE)",
            "=SUMIF(B2:B9,\">15\")+COUNTIF(C:C,\"x\")",
        ] {
            assert_eq!(round(f), f, "{f}");
        }
    }

    #[test]
    fn names_strings_and_structured_references_are_not_references() {
        let g = grid();
        for f in [
            "=LOG10(A1)",
            "=\"A1\"&A1",
            "=Table1[A1]+A1",
            "=myRate2*A1",
            "=A1.5",
        ] {
            let ids = to_ids(f, "s1", &g);
            assert_eq!(to_a1(&ids, "s1", &g), f, "{f}");
        }
        assert_eq!(to_ids("=LOG10(A1)", "s1", &g).matches(OPEN).count(), 1);
        assert_eq!(to_ids("=\"A1\"&A1", "s1", &g).matches(OPEN).count(), 1);
        assert_eq!(to_ids("=Table1[A1]", "s1", &g).matches(OPEN).count(), 0);
        assert_eq!(to_ids("=A1.5", "s1", &g).matches(OPEN).count(), 0);
    }

    #[test]
    fn canonical_form_and_what_is_kept_as_typed() {
        assert_eq!(round("=sum(b2:b3)"), "=sum(B2:B3)");
        assert_eq!(round("=budget!a1"), "=Budget!A1");
        assert_eq!(round("='Rates'!A1"), "=Rates!A1");
        // Outside the grid, an unknown sheet, a 3-D reference: as typed.
        let g = grid();
        for f in ["=A500", "=Nope!A1", "=Budget:Rates!A1", "=A1:A500"] {
            assert_eq!(to_ids(f, "s1", &g), f, "{f}");
        }
    }

    #[test]
    fn inserting_and_deleting_rows_moves_or_breaks_references() {
        let mut g = grid();
        let stored = to_ids("=SUM(B2:B9)+B10+Rates!A3", "s1", &g);
        g.sheets[0].2.insert(4, "new".into());
        assert_eq!(to_a1(&stored, "s1", &g), "=SUM(B2:B10)+B11+Rates!A3");
        g.sheets[0].2.retain(|r| r != "r9");
        assert_eq!(to_a1(&stored, "s1", &g), "=SUM(B2:B10)+#REF!+Rates!A3");
        g.sheets[1].1 = "Prices".into();
        assert_eq!(to_a1(&stored, "s1", &g), "=SUM(B2:B10)+#REF!+Prices!A3");
        g.sheets.remove(1);
        assert_eq!(to_a1(&stored, "s1", &g), "=SUM(B2:B10)+#REF!+#REF!");
    }

    #[test]
    fn shifting_moves_relative_parts_only() {
        assert_eq!(shift("=A1+$A$1+A$1+$A1", 2, 1), "=B3+$A$1+B$1+$A3");
        assert_eq!(shift("=SUM(A:A)+SUM(1:2)", 3, 2), "=SUM(C:C)+SUM(4:5)");
        assert_eq!(shift("=A1", -1, 0), "=#REF!");
        assert_eq!(shift("=\"A1\"&A1", 1, 0), "=\"A1\"&A2");
    }

    #[test]
    fn quoting_sheet_names() {
        assert_eq!(sheet_prefix("Budget"), "Budget!");
        assert_eq!(sheet_prefix("Q1 plan"), "'Q1 plan'!");
        assert_eq!(sheet_prefix("Amara's"), "'Amara''s'!");
        assert_eq!(sheet_prefix("A1"), "'A1'!");
        assert_eq!(sheet_prefix("2026"), "'2026'!");
        assert_eq!(sheet_prefix("AB"), "'AB'!");
    }
}
