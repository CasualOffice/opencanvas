// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The evaluator. Errors are values and propagate; a step budget per cell bounds the work.

use crate::syntax::{Expr, Node};
use crate::{ErrCode, Value, date};

/// Work allowed per cell: one step per node, one per list item a function walks.
pub const STEP_BUDGET: u32 = 60_000;

pub struct Ctx<'a> {
    pub get: &'a dyn Fn(&str) -> Value,
    pub today: i64,
    pub steps: u32,
}

fn err(c: ErrCode, m: impl Into<String>) -> Value {
    Value::Err(c, m.into())
}

fn type_err(what: &str, v: &Value) -> Value {
    err(
        ErrCode::Type,
        format!("{what} needs a number, got {}", v.ty().article()),
    )
}

/// A number from a value: empty counts as 0 (spreadsheet-like); errors pass through.
fn num(v: &Value, what: &str) -> Result<f64, Value> {
    match v {
        Value::Num(n) => Ok(*n),
        Value::Empty => Ok(0.0),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        Value::Err(..) => Err(v.clone()),
        _ => Err(type_err(what, v)),
    }
}

fn finite(n: f64) -> Value {
    if n.is_finite() {
        Value::Num(n)
    } else {
        err(ErrCode::Limit, "Number is too large")
    }
}

fn boolean(v: &Value, what: &str) -> Result<bool, Value> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Empty => Ok(false),
        Value::Err(..) => Err(v.clone()),
        _ => Err(err(
            ErrCode::Type,
            format!("{what} needs true or false, got {}", v.ty().article()),
        )),
    }
}

fn date_of(v: &Value, what: &str) -> Result<Option<i64>, Value> {
    match v {
        Value::Date(d) => Ok(Some(*d)),
        Value::Empty => Ok(None),
        Value::Text(s) => date::parse(s)
            .map(Some)
            .ok_or_else(|| err(ErrCode::Type, format!("{what} needs a date"))),
        Value::Err(..) => Err(v.clone()),
        _ => Err(err(
            ErrCode::Type,
            format!("{what} needs a date, got {}", v.ty().article()),
        )),
    }
}

/// Numbers as people read them: whole numbers without a point, others to 10 decimals at most.
pub fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return format!("{}", n as i64);
    }
    if n.abs() < 1e9 {
        let r = (n * 1e10).round() / 1e10;
        return format!("{r}");
    }
    format!("{n}")
}

pub fn text_of(v: &Value) -> String {
    match v {
        Value::Num(n) => fmt_num(*n),
        Value::Text(s) => s.clone(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Date(d) => date::format(*d),
        Value::List(l) => l.iter().map(text_of).collect::<Vec<_>>().join(", "),
        Value::Empty => String::new(),
        Value::Err(c, _) => c.as_str().into(),
    }
}

fn first_err(vs: &[Value]) -> Option<Value> {
    vs.iter().find(|v| matches!(v, Value::Err(..))).cloned()
}

fn cmp(a: &Value, b: &Value) -> Option<std::cmp::Ordering> {
    use Value::*;
    match (a, b) {
        (Num(x), Num(y)) => x.partial_cmp(y),
        (Text(x), Text(y)) => Some(x.to_lowercase().cmp(&y.to_lowercase())),
        (Bool(x), Bool(y)) => Some(x.cmp(y)),
        (Date(x), Date(y)) => Some(x.cmp(y)),
        (Empty, Empty) => Some(std::cmp::Ordering::Equal),
        (Empty, Num(_)) => cmp(&Num(0.0), b),
        (Num(_), Empty) => cmp(a, &Num(0.0)),
        (Empty, Text(_)) => cmp(&Text(String::new()), b),
        (Text(_), Empty) => cmp(a, &Text(String::new())),
        (Empty, Bool(_)) => cmp(&Bool(false), b),
        (Bool(_), Empty) => cmp(a, &Bool(false)),
        (Empty, _) => Some(std::cmp::Ordering::Less),
        (_, Empty) => Some(std::cmp::Ordering::Greater),
        (List(x), List(y)) => (x.len() == y.len()
            && x.iter()
                .zip(y)
                .all(|(p, q)| cmp(p, q) == Some(std::cmp::Ordering::Equal)))
        .then_some(std::cmp::Ordering::Equal)
        .or(Some(std::cmp::Ordering::Less)),
        _ => None,
    }
}

/// Flattens arguments (lists spread) into numbers; text and other non-numbers in lists are skipped.
fn numbers(c: &mut Ctx, vs: &[Value], what: &str) -> Result<Vec<f64>, Value> {
    let mut out = Vec::new();
    for v in vs {
        match v {
            Value::List(l) => {
                c.steps += l.len() as u32;
                if c.steps > STEP_BUDGET {
                    return Err(limit());
                }
                for x in l {
                    match x {
                        Value::Num(n) => out.push(*n),
                        Value::Err(..) => return Err(x.clone()),
                        _ => {}
                    }
                }
            }
            Value::Empty => {}
            _ => out.push(num(v, what)?),
        }
    }
    Ok(out)
}

fn limit() -> Value {
    err(ErrCode::Limit, "Formula took too many steps")
}

fn unit_of(v: &Value) -> Result<&'static str, Value> {
    let Value::Text(s) = v else {
        return Err(err(ErrCode::Type, "Unit must be text such as \"days\""));
    };
    Ok(match s.trim().to_ascii_lowercase().trim_end_matches('s') {
        "day" => "days",
        "week" => "weeks",
        "month" => "months",
        "year" => "years",
        _ => {
            return Err(err(
                ErrCode::Type,
                format!("Unknown unit “{s}”: use days, weeks, months or years"),
            ));
        }
    })
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return e,
        }
    };
}

pub fn eval(n: &Node, c: &mut Ctx) -> Value {
    c.steps += 1;
    if c.steps > STEP_BUDGET {
        return limit();
    }
    match &n.e {
        Expr::Num(x) => Value::Num(*x),
        Expr::Str(s) => Value::Text(s.clone()),
        Expr::Bool(b) => Value::Bool(*b),
        Expr::Prop(p) => (c.get)(p),
        Expr::Neg(x) => {
            let v = eval(x, c);
            finite(-tri!(num(&v, "Minus")))
        }
        Expr::Bin(op, a, b) => {
            let (va, vb) = (eval(a, c), eval(b, c));
            if let Some(e) = first_err(&[va.clone(), vb.clone()]) {
                return e;
            }
            match *op {
                "&" => Value::Text(text_of(&va) + &text_of(&vb)),
                "=" | "<>" | "<" | ">" | "<=" | ">=" => {
                    use std::cmp::Ordering::*;
                    let Some(o) = cmp(&va, &vb) else {
                        return err(
                            ErrCode::Type,
                            format!(
                                "Cannot compare {} with {}",
                                va.ty().article(),
                                vb.ty().article()
                            ),
                        );
                    };
                    Value::Bool(match *op {
                        "=" => o == Equal,
                        "<>" => o != Equal,
                        "<" => o == Less,
                        ">" => o == Greater,
                        "<=" => o != Greater,
                        _ => o != Less,
                    })
                }
                "+" | "-" if matches!(va, Value::Date(_)) || matches!(vb, Value::Date(_)) => {
                    match (&va, &vb, *op) {
                        (Value::Date(x), Value::Date(y), "-") => Value::Num((x - y) as f64),
                        (Value::Date(x), other, _) | (other, Value::Date(x), "+") => {
                            let d = tri!(num(other, "A date plus days"));
                            let d = if *op == "-" { -d } else { d };
                            if d.abs() > 3_000_000.0 {
                                return err(ErrCode::Limit, "Date is out of range");
                            }
                            Value::Date(x + d.trunc() as i64)
                        }
                        _ => err(ErrCode::Type, "Cannot subtract a date from a number"),
                    }
                }
                _ => {
                    if matches!(va, Value::Text(_)) || matches!(vb, Value::Text(_)) {
                        return err(
                            ErrCode::Type,
                            if *op == "+" {
                                "Use & to join text".to_string()
                            } else {
                                format!("“{op}” needs numbers")
                            },
                        );
                    }
                    let x = tri!(num(&va, op));
                    let y = tri!(num(&vb, op));
                    match *op {
                        "+" => finite(x + y),
                        "-" => finite(x - y),
                        "*" => finite(x * y),
                        _ if y == 0.0 => err(ErrCode::Div0, "Division by zero"),
                        _ => finite(x / y),
                    }
                }
            }
        }
        Expr::Call(name, args) => call(name, args, c),
    }
}

fn call(name: &str, args: &[Node], c: &mut Ctx) -> Value {
    match crate::check::func(name) {
        None => return err(ErrCode::Ref, format!("Unknown function {name}")),
        Some(f) if args.len() < f.min || args.len() > f.max => {
            return err(
                ErrCode::Type,
                format!("Wrong number of arguments: {}", f.sig),
            );
        }
        _ => {}
    }
    // Lazy functions first: only the branch taken is evaluated.
    match name {
        "IF" => {
            let cond = eval(&args[0], c);
            return if tri!(boolean(&cond, "IF")) {
                eval(&args[1], c)
            } else {
                args.get(2).map_or(Value::Empty, |a| eval(a, c))
            };
        }
        "IFERROR" => {
            let v = eval(&args[0], c);
            return if matches!(v, Value::Err(ErrCode::Limit, _)) || !matches!(v, Value::Err(..)) {
                v
            } else {
                eval(&args[1], c)
            };
        }
        "ISBLANK" => {
            let v = eval(&args[0], c);
            return Value::Bool(match &v {
                Value::Empty => true,
                Value::Text(s) => s.is_empty(),
                Value::List(l) => l.is_empty(),
                _ => false,
            });
        }
        _ => {}
    }
    let vs: Vec<Value> = args.iter().map(|a| eval(a, c)).collect();
    if c.steps > STEP_BUDGET {
        return limit();
    }
    if let Some(e) = first_err(&vs) {
        return e;
    }
    let n = |i: usize| num(&vs[i], name);
    let t = |i: usize| -> Result<String, Value> {
        match &vs[i] {
            Value::Text(s) => Ok(s.clone()),
            Value::Empty => Ok(String::new()),
            v => Err(err(
                ErrCode::Type,
                format!("{name} needs text, got {}", v.ty().article()),
            )),
        }
    };
    match name {
        "AND" | "OR" | "NOT" => {
            let bs: Vec<bool> = tri!(
                vs.iter()
                    .map(|v| boolean(v, name))
                    .collect::<Result<_, _>>()
            );
            Value::Bool(match name {
                "AND" => bs.iter().all(|b| *b),
                "OR" => bs.iter().any(|b| *b),
                _ => !bs[0],
            })
        }
        "SUM" => finite(tri!(numbers(c, &vs, name)).iter().sum()),
        "AVERAGE" => {
            let ns = tri!(numbers(c, &vs, name));
            if ns.is_empty() {
                err(ErrCode::Div0, "AVERAGE of nothing")
            } else {
                finite(ns.iter().sum::<f64>() / ns.len() as f64)
            }
        }
        "MIN" | "MAX" => {
            let ns = tri!(numbers(c, &vs, name));
            let it = ns.into_iter();
            let r = if name == "MIN" {
                it.reduce(f64::min)
            } else {
                it.reduce(f64::max)
            };
            r.map_or(Value::Empty, Value::Num)
        }
        "ROUND" => {
            let x = tri!(n(0));
            let d = if vs.len() > 1 {
                tri!(n(1)).trunc().clamp(-15.0, 15.0)
            } else {
                0.0
            };
            let p = 10f64.powi(d as i32);
            finite((x * p).round() / p)
        }
        "ABS" => finite(tri!(n(0)).abs()),
        "FLOOR" => finite(tri!(n(0)).floor()),
        "CEILING" => finite(tri!(n(0)).ceil()),
        "MOD" => {
            let (x, y) = (tri!(n(0)), tri!(n(1)));
            if y == 0.0 {
                err(ErrCode::Div0, "MOD by zero")
            } else {
                finite(x - y * (x / y).floor())
            }
        }
        "POWER" => finite(tri!(n(0)).powf(tri!(n(1)))),
        "SQRT" => {
            let x = tri!(n(0));
            if x < 0.0 {
                err(ErrCode::Type, "SQRT of a negative number")
            } else {
                Value::Num(x.sqrt())
            }
        }
        "LEN" => match &vs[0] {
            Value::List(l) => Value::Num(l.len() as f64),
            _ => Value::Num(tri!(t(0)).chars().count() as f64),
        },
        "UPPER" => Value::Text(tri!(t(0)).to_uppercase()),
        "LOWER" => Value::Text(tri!(t(0)).to_lowercase()),
        "TRIM" => Value::Text(tri!(t(0)).trim().to_string()),
        "LEFT" | "RIGHT" => {
            let s = tri!(t(0));
            let k = tri!(n(1)).max(0.0) as usize;
            let len = s.chars().count();
            Value::Text(if name == "LEFT" {
                s.chars().take(k).collect()
            } else {
                s.chars().skip(len.saturating_sub(k)).collect()
            })
        }
        "CONCAT" => Value::Text(vs.iter().map(text_of).collect()),
        "TEXT" => Value::Text(text_of(&vs[0])),
        "CONTAINS" => {
            let part = text_of(&vs[1]).to_lowercase();
            match &vs[0] {
                Value::List(l) => Value::Bool(l.iter().any(|x| text_of(x).to_lowercase() == part)),
                _ => Value::Bool(tri!(t(0)).to_lowercase().contains(&part)),
            }
        }
        "VALUE" => match &vs[0] {
            Value::Num(x) => Value::Num(*x),
            Value::Empty => Value::Empty,
            v => text_of(v)
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|x| x.is_finite())
                .map_or_else(
                    || err(ErrCode::Type, format!("“{}” is not a number", text_of(v))),
                    Value::Num,
                ),
        },
        "COUNT" => match &vs[0] {
            Value::List(l) => Value::Num(l.len() as f64),
            Value::Empty => Value::Num(0.0),
            _ => Value::Num(1.0),
        },
        "JOIN" => {
            let sep = tri!(t(1));
            match &vs[0] {
                Value::List(l) => Value::Text(l.iter().map(text_of).collect::<Vec<_>>().join(&sep)),
                v => Value::Text(text_of(v)),
            }
        }
        "TODAY" | "NOW" => Value::Date(c.today),
        "EMPTY" => Value::Empty,
        "DATE" => {
            let (y, m, d) = (tri!(n(0)), tri!(n(1)), tri!(n(2)));
            if !(1.0..=9999.0).contains(&y) || m.abs() > 120_000.0 || d.abs() > 3_000_000.0 {
                return err(ErrCode::Limit, "Date is out of range");
            }
            Value::Date(date::from_civil(y as i64, m as i64, 1) + d as i64 - 1)
        }
        "YEAR" | "MONTH" | "DAY" | "WEEKDAY" => {
            let Some(d) = tri!(date_of(&vs[0], name)) else {
                return Value::Empty;
            };
            let (y, m, dd) = date::to_civil(d);
            Value::Num(match name {
                "YEAR" => y,
                "MONTH" => m,
                "DAY" => dd,
                _ => (d + 3).rem_euclid(7) + 1,
            } as f64)
        }
        "DATEADD" => {
            let Some(d) = tri!(date_of(&vs[0], name)) else {
                return Value::Empty;
            };
            let k = tri!(n(1));
            if k.abs() > 1_000_000.0 {
                return err(ErrCode::Limit, "Date is out of range");
            }
            let k = k.trunc() as i64;
            Value::Date(match tri!(unit_of(&vs[2])) {
                "days" => d + k,
                "weeks" => d + 7 * k,
                "months" => date::add_months(d, k),
                _ => date::add_months(d, 12 * k),
            })
        }
        "DATEDIFF" => {
            let (Some(a), Some(b)) = (tri!(date_of(&vs[0], name)), tri!(date_of(&vs[1], name)))
            else {
                return Value::Empty;
            };
            Value::Num(match tri!(unit_of(&vs[2])) {
                "days" => b - a,
                "weeks" => (b - a) / 7,
                "months" => date::months_between(a, b),
                _ => date::months_between(a, b) / 12,
            } as f64)
        }
        _ => err(ErrCode::Ref, format!("Unknown function {name}")),
    }
}
