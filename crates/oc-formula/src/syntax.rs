// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Lexer, parser and printer for the spreadsheet-like formula syntax (docs/36 §6.1, prototype 1a):
//! `prop("Price") * prop("Qty")`, upper-case functions accepted in any case, `&` joins text,
//! `""` escapes a quote inside a string.

use crate::{ErrCode, FormulaError};

/// Source size limit (bytes) and nesting depth limit.
pub const MAX_SRC: usize = 4096;
pub const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    LParen,
    RParen,
    Comma,
    Op(&'static str),
}

/// A token and its byte span in the source.
#[derive(Debug, Clone, PartialEq)]
pub struct Spanned {
    pub tok: Tok,
    pub start: usize,
    pub end: usize,
}

fn fe(code: ErrCode, msg: impl Into<String>, pos: usize) -> FormulaError {
    FormulaError {
        code,
        msg: msg.into(),
        pos,
    }
}

pub fn lex(src: &str) -> Result<Vec<Spanned>, FormulaError> {
    let b = src.as_bytes();
    let mut i = 0;
    let mut out = Vec::new();
    while i < b.len() {
        let c = b[i];
        let start = i;
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let tok = if c.is_ascii_digit()
            || (c == b'.' && b.get(i + 1).is_some_and(u8::is_ascii_digit))
        {
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
                i += 1;
            }
            if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
                let mut j = i + 1;
                if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
                    j += 1;
                }
                if j < b.len() && b[j].is_ascii_digit() {
                    i = j;
                    while i < b.len() && b[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            let n: f64 = src[start..i].parse().map_err(|_| {
                fe(
                    ErrCode::Type,
                    format!("“{}” is not a number", &src[start..i]),
                    start,
                )
            })?;
            Tok::Num(n)
        } else if c == b'"' {
            let mut s = String::new();
            i += 1;
            loop {
                match src[i..].find('"') {
                    None => {
                        return Err(fe(
                            ErrCode::Type,
                            "Text is missing its closing quote",
                            start,
                        ));
                    }
                    Some(k) => {
                        s.push_str(&src[i..i + k]);
                        i += k + 1;
                        if b.get(i) == Some(&b'"') {
                            s.push('"');
                            i += 1;
                        } else {
                            break;
                        }
                    }
                }
            }
            Tok::Str(s)
        } else if c.is_ascii_alphabetic() || c == b'_' {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                i += 1;
            }
            Tok::Ident(src[start..i].to_string())
        } else {
            i += 1;
            match c {
                b'(' => Tok::LParen,
                b')' => Tok::RParen,
                b',' => Tok::Comma,
                b'+' => Tok::Op("+"),
                b'-' => Tok::Op("-"),
                b'*' => Tok::Op("*"),
                b'/' => Tok::Op("/"),
                b'&' => Tok::Op("&"),
                b'=' => Tok::Op("="),
                b'<' if b.get(i) == Some(&b'>') => {
                    i += 1;
                    Tok::Op("<>")
                }
                b'<' if b.get(i) == Some(&b'=') => {
                    i += 1;
                    Tok::Op("<=")
                }
                b'>' if b.get(i) == Some(&b'=') => {
                    i += 1;
                    Tok::Op(">=")
                }
                b'<' => Tok::Op("<"),
                b'>' => Tok::Op(">"),
                b'!' if b.get(i) == Some(&b'=') => {
                    i += 1;
                    Tok::Op("<>")
                }
                _ => {
                    let ch = src[start..].chars().next().unwrap_or('?');
                    return Err(fe(ErrCode::Type, format!("Unexpected “{ch}”"), start));
                }
            }
        };
        out.push(Spanned { tok, start, end: i });
    }
    Ok(out)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Prop(String),
    Call(String, Vec<Node>),
    Neg(Box<Node>),
    Bin(&'static str, Box<Node>, Box<Node>),
}

/// An expression and the byte offset where it starts.
#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    pub e: Expr,
    pub pos: usize,
}

struct P<'a> {
    t: &'a [Spanned],
    i: usize,
    depth: usize,
    len: usize,
}

impl P<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i).map(|s| &s.tok)
    }
    fn pos(&self) -> usize {
        self.t.get(self.i).map_or(self.len, |s| s.start)
    }
    fn deeper(&mut self) -> Result<(), FormulaError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(fe(
                ErrCode::Limit,
                format!("Formula is nested deeper than {MAX_DEPTH} levels"),
                self.pos(),
            ));
        }
        Ok(())
    }
    fn binary(&mut self, level: usize) -> Result<Node, FormulaError> {
        const LEVELS: [&[&str]; 4] = [
            &["=", "<>", "<", ">", "<=", ">="],
            &["&"],
            &["+", "-"],
            &["*", "/"],
        ];
        if level == LEVELS.len() {
            return self.unary();
        }
        let mut lhs = self.binary(level + 1)?;
        while let Some(Tok::Op(op)) = self.peek() {
            let op = *op;
            if !LEVELS[level].contains(&op) {
                break;
            }
            self.i += 1;
            self.deeper()?;
            let rhs = self.binary(level + 1)?;
            self.depth -= 1;
            let pos = lhs.pos;
            lhs = Node {
                e: Expr::Bin(op, Box::new(lhs), Box::new(rhs)),
                pos,
            };
        }
        Ok(lhs)
    }
    fn unary(&mut self) -> Result<Node, FormulaError> {
        if let Some(Tok::Op("-")) = self.peek() {
            let pos = self.pos();
            self.i += 1;
            self.deeper()?;
            let inner = self.unary()?;
            self.depth -= 1;
            return Ok(Node {
                e: Expr::Neg(Box::new(inner)),
                pos,
            });
        }
        if let Some(Tok::Op("+")) = self.peek() {
            self.i += 1;
            return self.unary();
        }
        self.primary()
    }
    fn expect(&mut self, want: Tok, what: &str) -> Result<(), FormulaError> {
        if self.peek() == Some(&want) {
            self.i += 1;
            Ok(())
        } else {
            Err(fe(ErrCode::Type, format!("Expected {what}"), self.pos()))
        }
    }
    fn primary(&mut self) -> Result<Node, FormulaError> {
        let pos = self.pos();
        let Some(tok) = self.peek().cloned() else {
            return Err(fe(ErrCode::Type, "Formula ends too early", pos));
        };
        self.i += 1;
        let e = match tok {
            Tok::Num(n) => Expr::Num(n),
            Tok::Str(s) => Expr::Str(s),
            Tok::LParen => {
                self.deeper()?;
                let inner = self.binary(0)?;
                self.depth -= 1;
                self.expect(Tok::RParen, "“)”")?;
                return Ok(Node { e: inner.e, pos });
            }
            Tok::Ident(name) => {
                let up = name.to_ascii_uppercase();
                if self.peek() != Some(&Tok::LParen) {
                    return match up.as_str() {
                        "TRUE" => Ok(Node {
                            e: Expr::Bool(true),
                            pos,
                        }),
                        "FALSE" => Ok(Node {
                            e: Expr::Bool(false),
                            pos,
                        }),
                        _ => Err(fe(
                            ErrCode::Ref,
                            format!("Unknown name “{name}”; write prop(\"{name}\") for a field"),
                            pos,
                        )),
                    };
                }
                self.i += 1;
                self.deeper()?;
                let mut args = Vec::new();
                if self.peek() != Some(&Tok::RParen) {
                    loop {
                        args.push(self.binary(0)?);
                        if self.peek() == Some(&Tok::Comma) {
                            self.i += 1;
                        } else {
                            break;
                        }
                    }
                }
                self.depth -= 1;
                self.expect(Tok::RParen, "“,” or “)”")?;
                if up == "PROP" {
                    return match args.as_slice() {
                        [
                            Node {
                                e: Expr::Str(s), ..
                            },
                        ] => Ok(Node {
                            e: Expr::Prop(s.clone()),
                            pos,
                        }),
                        _ => Err(fe(
                            ErrCode::Type,
                            "prop takes one field name in quotes",
                            pos,
                        )),
                    };
                }
                Expr::Call(up, args)
            }
            Tok::RParen | Tok::Comma | Tok::Op(_) => {
                return Err(fe(ErrCode::Type, "Expected a value", pos));
            }
        };
        Ok(Node { e, pos })
    }
}

pub fn parse(src: &str) -> Result<Node, FormulaError> {
    if src.len() > MAX_SRC {
        return Err(fe(
            ErrCode::Limit,
            format!("Formula is longer than {} KB", MAX_SRC / 1024),
            MAX_SRC,
        ));
    }
    let toks = lex(src)?;
    if toks.is_empty() {
        return Err(fe(ErrCode::Type, "Formula is empty", 0));
    }
    let mut p = P {
        t: &toks,
        i: 0,
        depth: 0,
        len: src.len(),
    };
    let n = p.binary(0)?;
    if p.i < toks.len() {
        return Err(fe(
            ErrCode::Type,
            "Expected an operator or the end",
            p.pos(),
        ));
    }
    Ok(n)
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Prints a node in canonical form: binary operations in parentheses, functions upper case.
pub fn print(n: &Node) -> String {
    match &n.e {
        Expr::Num(x) => format!("{x}"),
        Expr::Str(s) => quote(s),
        Expr::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
        Expr::Prop(p) => format!("prop({})", quote(p)),
        Expr::Call(f, a) => format!(
            "{f}({})",
            a.iter().map(print).collect::<Vec<_>>().join(", ")
        ),
        Expr::Neg(x) => format!("-{}", print(x)),
        Expr::Bin(op, a, b) => format!("({} {op} {})", print(a), print(b)),
    }
}

/// Rewrites token spans in `src`, keeping everything else (spacing, literals) as typed.
fn rewrite(src: &str, f: impl Fn(&[Spanned], usize) -> Option<String>) -> String {
    let Ok(toks) = lex(src) else {
        return src.to_string();
    };
    let mut out = String::with_capacity(src.len());
    let mut last = 0;
    for i in 0..toks.len() {
        if let Some(r) = f(&toks, i) {
            out.push_str(&src[last..toks[i].start]);
            out.push_str(&r);
            last = toks[i].end;
        }
    }
    out.push_str(&src[last..]);
    out
}

/// Function names (and TRUE/FALSE) upper case, `prop` lower case; the rest as typed.
pub fn normalize(src: &str) -> String {
    rewrite(src, |t, i| match &t[i].tok {
        Tok::Ident(name) => {
            let call = t.get(i + 1).is_some_and(|n| n.tok == Tok::LParen);
            let up = name.to_ascii_uppercase();
            let want = if call && up == "PROP" {
                "prop".to_string()
            } else if call || up == "TRUE" || up == "FALSE" {
                up
            } else {
                return None;
            };
            (want != *name).then_some(want)
        }
        _ => None,
    })
}

/// Rewrites `prop("old")` to `prop("new")` (a field rename).
pub fn rename_prop(src: &str, old: &str, new: &str) -> String {
    let src = normalize(src);
    rewrite(&src, |t, i| {
        let is_prop = |k: usize| matches!(t.get(k).map(|s| &s.tok), Some(Tok::Ident(n)) if n.eq_ignore_ascii_case("prop"));
        match &t[i].tok {
            Tok::Str(s) if s == old && i >= 2 && t[i - 1].tok == Tok::LParen && is_prop(i - 2) => {
                Some(quote(new))
            }
            _ => None,
        }
    })
}

/// Field names a formula refers to through `prop("…")`.
pub fn props(n: &Node, out: &mut Vec<String>) {
    match &n.e {
        Expr::Prop(p) => {
            if !out.contains(p) {
                out.push(p.clone());
            }
        }
        Expr::Call(_, a) => a.iter().for_each(|x| props(x, out)),
        Expr::Neg(x) => props(x, out),
        Expr::Bin(_, a, b) => {
            props(a, out);
            props(b, out);
        }
        _ => {}
    }
}
