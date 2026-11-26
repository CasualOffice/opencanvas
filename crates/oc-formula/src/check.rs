// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The type checker: infers a formula's result type and rejects mismatches at edit time with a
//! position (prototype 1c, 1e). Mixed IF branches are `#TYPE`, never a silent conversion.

use crate::syntax::{Expr, Node};
use crate::{ErrCode, FormulaError, Ty};

fn te(msg: impl Into<String>, pos: usize) -> FormulaError {
    FormulaError {
        code: ErrCode::Type,
        msg: msg.into(),
        pos,
    }
}

/// One built-in function: name, signature for autocomplete, a one-line description.
pub struct Func {
    pub name: &'static str,
    pub sig: &'static str,
    pub doc: &'static str,
    pub min: usize,
    pub max: usize,
}

const MANY: usize = 255;

pub const FUNCS: &[Func] = &[
    Func {
        name: "IF",
        sig: "IF(condition, then, else)",
        doc: "One of two values, by a condition",
        min: 2,
        max: 3,
    },
    Func {
        name: "IFERROR",
        sig: "IFERROR(value, fallback)",
        doc: "The fallback when the value is an error",
        min: 2,
        max: 2,
    },
    Func {
        name: "AND",
        sig: "AND(a, b, …)",
        doc: "True when every condition is true",
        min: 1,
        max: MANY,
    },
    Func {
        name: "OR",
        sig: "OR(a, b, …)",
        doc: "True when any condition is true",
        min: 1,
        max: MANY,
    },
    Func {
        name: "NOT",
        sig: "NOT(condition)",
        doc: "The opposite of a condition",
        min: 1,
        max: 1,
    },
    Func {
        name: "SUM",
        sig: "SUM(a, b, …)",
        doc: "Adds numbers and lists of numbers",
        min: 1,
        max: MANY,
    },
    Func {
        name: "AVERAGE",
        sig: "AVERAGE(a, b, …)",
        doc: "The mean of numbers",
        min: 1,
        max: MANY,
    },
    Func {
        name: "MIN",
        sig: "MIN(a, b, …)",
        doc: "The smallest number",
        min: 1,
        max: MANY,
    },
    Func {
        name: "MAX",
        sig: "MAX(a, b, …)",
        doc: "The largest number",
        min: 1,
        max: MANY,
    },
    Func {
        name: "ROUND",
        sig: "ROUND(number, digits)",
        doc: "Rounds to a number of decimal places",
        min: 1,
        max: 2,
    },
    Func {
        name: "ABS",
        sig: "ABS(number)",
        doc: "The absolute value",
        min: 1,
        max: 1,
    },
    Func {
        name: "FLOOR",
        sig: "FLOOR(number)",
        doc: "Rounds down to a whole number",
        min: 1,
        max: 1,
    },
    Func {
        name: "CEILING",
        sig: "CEILING(number)",
        doc: "Rounds up to a whole number",
        min: 1,
        max: 1,
    },
    Func {
        name: "MOD",
        sig: "MOD(number, divisor)",
        doc: "The remainder of a division",
        min: 2,
        max: 2,
    },
    Func {
        name: "POWER",
        sig: "POWER(number, exponent)",
        doc: "A number raised to a power",
        min: 2,
        max: 2,
    },
    Func {
        name: "SQRT",
        sig: "SQRT(number)",
        doc: "The square root",
        min: 1,
        max: 1,
    },
    Func {
        name: "LEN",
        sig: "LEN(text)",
        doc: "Characters in text, or items in a list",
        min: 1,
        max: 1,
    },
    Func {
        name: "UPPER",
        sig: "UPPER(text)",
        doc: "Text in upper case",
        min: 1,
        max: 1,
    },
    Func {
        name: "LOWER",
        sig: "LOWER(text)",
        doc: "Text in lower case",
        min: 1,
        max: 1,
    },
    Func {
        name: "TRIM",
        sig: "TRIM(text)",
        doc: "Text without surrounding spaces",
        min: 1,
        max: 1,
    },
    Func {
        name: "LEFT",
        sig: "LEFT(text, count)",
        doc: "The first characters of text",
        min: 2,
        max: 2,
    },
    Func {
        name: "RIGHT",
        sig: "RIGHT(text, count)",
        doc: "The last characters of text",
        min: 2,
        max: 2,
    },
    Func {
        name: "CONCAT",
        sig: "CONCAT(a, b, …)",
        doc: "Joins values as text",
        min: 1,
        max: MANY,
    },
    Func {
        name: "CONTAINS",
        sig: "CONTAINS(text, part)",
        doc: "True when text contains a part (any case)",
        min: 2,
        max: 2,
    },
    Func {
        name: "TEXT",
        sig: "TEXT(value)",
        doc: "A value as text",
        min: 1,
        max: 1,
    },
    Func {
        name: "VALUE",
        sig: "VALUE(text)",
        doc: "Text as a number",
        min: 1,
        max: 1,
    },
    Func {
        name: "ISBLANK",
        sig: "ISBLANK(value)",
        doc: "True when a value is empty",
        min: 1,
        max: 1,
    },
    Func {
        name: "COUNT",
        sig: "COUNT(list)",
        doc: "Items in a list",
        min: 1,
        max: 1,
    },
    Func {
        name: "JOIN",
        sig: "JOIN(list, separator)",
        doc: "List items joined into text",
        min: 2,
        max: 2,
    },
    Func {
        name: "NOW",
        sig: "NOW()",
        doc: "Today's date (dates have no time of day)",
        min: 0,
        max: 0,
    },
    Func {
        name: "EMPTY",
        sig: "EMPTY",
        doc: "An empty value (shows as a dash)",
        min: 0,
        max: 0,
    },
    Func {
        name: "TODAY",
        sig: "TODAY()",
        doc: "Today's date",
        min: 0,
        max: 0,
    },
    Func {
        name: "DATE",
        sig: "DATE(year, month, day)",
        doc: "A date from its parts",
        min: 3,
        max: 3,
    },
    Func {
        name: "YEAR",
        sig: "YEAR(date)",
        doc: "The year of a date",
        min: 1,
        max: 1,
    },
    Func {
        name: "MONTH",
        sig: "MONTH(date)",
        doc: "The month of a date (1–12)",
        min: 1,
        max: 1,
    },
    Func {
        name: "DAY",
        sig: "DAY(date)",
        doc: "The day of the month",
        min: 1,
        max: 1,
    },
    Func {
        name: "WEEKDAY",
        sig: "WEEKDAY(date)",
        doc: "Day of the week, 1 (Monday) to 7",
        min: 1,
        max: 1,
    },
    Func {
        name: "DATEADD",
        sig: "DATEADD(date, amount, \"days\")",
        doc: "A date plus days, weeks, months or years",
        min: 3,
        max: 3,
    },
    Func {
        name: "DATEDIFF",
        sig: "DATEDIFF(start, end, \"days\")",
        doc: "Days, weeks, months or years between dates",
        min: 3,
        max: 3,
    },
];

pub fn func(name: &str) -> Option<&'static Func> {
    FUNCS.iter().find(|f| f.name == name)
}

/// Joins two branch types: equal, or one is unknown (`Any`).
fn unify(a: Ty, b: Ty) -> Option<Ty> {
    match (a, b) {
        (Ty::Any, t) | (t, Ty::Any) => Some(t),
        (x, y) if x == y => Some(x),
        _ => None,
    }
}

fn want(t: Ty, w: Ty, what: &str, n: &Node) -> Result<(), FormulaError> {
    if unify(t, w).is_some() {
        Ok(())
    } else {
        Err(te(
            format!("{what} needs {}, got {}", w.article(), t.article()),
            n.pos,
        ))
    }
}

pub fn infer(n: &Node, schema: &dyn Fn(&str) -> Option<Ty>) -> Result<Ty, FormulaError> {
    Ok(match &n.e {
        Expr::Num(_) => Ty::Num,
        Expr::Str(_) => Ty::Text,
        Expr::Bool(_) => Ty::Bool,
        Expr::Prop(p) => schema(p).ok_or_else(|| FormulaError {
            code: ErrCode::Ref,
            msg: format!("No field named “{p}”"),
            pos: n.pos,
        })?,
        Expr::Neg(x) => {
            want(infer(x, schema)?, Ty::Num, "Minus", x)?;
            Ty::Num
        }
        Expr::Bin(op, a, b) => {
            let (ta, tb) = (infer(a, schema)?, infer(b, schema)?);
            match *op {
                "&" => Ty::Text,
                "=" | "<>" => {
                    if unify(ta, tb).is_none() {
                        return Err(te(
                            format!("Cannot compare {} with {}", ta.article(), tb.article()),
                            b.pos,
                        ));
                    }
                    Ty::Bool
                }
                "<" | ">" | "<=" | ">=" => {
                    if unify(ta, tb).is_none() || matches!(unify(ta, tb), Some(Ty::List | Ty::Bool))
                    {
                        return Err(te(
                            format!("Cannot order {} and {}", ta.article(), tb.article()),
                            b.pos,
                        ));
                    }
                    Ty::Bool
                }
                "+" | "-" => match (ta, tb) {
                    (Ty::Date, Ty::Date) if *op == "-" => Ty::Num,
                    (Ty::Date, t) => {
                        want(t, Ty::Num, "A date plus days", b)?;
                        Ty::Date
                    }
                    (Ty::Any, Ty::Date) if *op == "-" => Ty::Any,
                    (t, Ty::Date) if *op == "+" => {
                        want(t, Ty::Num, "A date plus days", a)?;
                        Ty::Date
                    }
                    (Ty::Text, _) | (_, Ty::Text) if *op == "+" => {
                        let at = if ta == Ty::Text { a } else { b };
                        return Err(te("Use & to join text", at.pos));
                    }
                    _ => {
                        want(ta, Ty::Num, &format!("“{op}”"), a)?;
                        want(tb, Ty::Num, &format!("“{op}”"), b)?;
                        if ta == Ty::Any && tb == Ty::Any {
                            Ty::Any
                        } else {
                            Ty::Num
                        }
                    }
                },
                _ => {
                    want(ta, Ty::Num, &format!("“{op}”"), a)?;
                    want(tb, Ty::Num, &format!("“{op}”"), b)?;
                    Ty::Num
                }
            }
        }
        Expr::Call(name, args) => {
            let Some(f) = func(name) else {
                return Err(FormulaError {
                    code: ErrCode::Ref,
                    msg: format!("Unknown function {name}"),
                    pos: n.pos,
                });
            };
            if args.len() < f.min || args.len() > f.max {
                let n_args = if f.min == f.max {
                    format!("{}", f.min)
                } else if f.max == MANY {
                    format!("at least {}", f.min)
                } else {
                    format!("{} to {}", f.min, f.max)
                };
                return Err(te(
                    format!(
                        "{name} takes {n_args} argument{}: {}",
                        if f.max == 1 { "" } else { "s" },
                        f.sig
                    ),
                    n.pos,
                ));
            }
            let ts = args
                .iter()
                .map(|a| infer(a, schema))
                .collect::<Result<Vec<_>, _>>()?;
            let all = |w: Ty| -> Result<(), FormulaError> {
                args.iter()
                    .zip(&ts)
                    .try_for_each(|(a, t)| want(*t, w, name, a))
            };
            let at = |i: usize, w: Ty| want(ts[i], w, name, &args[i]);
            match name.as_str() {
                "IF" => {
                    at(0, Ty::Bool)?;
                    let other = ts.get(2).copied().unwrap_or(Ty::Any);
                    unify(ts[1], other).ok_or_else(|| {
                        te(
                            format!(
                                "IF returns {} in one branch and {} in the other",
                                ts[1].noun(),
                                other.noun()
                            ),
                            args[2].pos,
                        )
                    })?
                }
                "IFERROR" => unify(ts[0], ts[1]).ok_or_else(|| {
                    te(
                        format!("IFERROR mixes {} and {}", ts[0].noun(), ts[1].noun()),
                        args[1].pos,
                    )
                })?,
                "AND" | "OR" | "NOT" => {
                    all(Ty::Bool)?;
                    Ty::Bool
                }
                "SUM" | "AVERAGE" | "MIN" | "MAX" => {
                    for (a, t) in args.iter().zip(&ts) {
                        if *t != Ty::List {
                            want(*t, Ty::Num, name, a)?;
                        }
                    }
                    Ty::Num
                }
                "ROUND" | "ABS" | "FLOOR" | "CEILING" | "MOD" | "POWER" | "SQRT" => {
                    all(Ty::Num)?;
                    Ty::Num
                }
                "LEN" => {
                    if ts[0] != Ty::List {
                        at(0, Ty::Text)?;
                    }
                    Ty::Num
                }
                "UPPER" | "LOWER" | "TRIM" => {
                    at(0, Ty::Text)?;
                    Ty::Text
                }
                "LEFT" | "RIGHT" => {
                    at(0, Ty::Text)?;
                    at(1, Ty::Num)?;
                    Ty::Text
                }
                "CONCAT" | "TEXT" => Ty::Text,
                "CONTAINS" => {
                    if ts[0] != Ty::List {
                        at(0, Ty::Text)?;
                    }
                    Ty::Bool
                }
                "VALUE" => Ty::Num,
                "ISBLANK" => Ty::Bool,
                "COUNT" => {
                    at(0, Ty::List)?;
                    Ty::Num
                }
                "JOIN" => {
                    at(0, Ty::List)?;
                    at(1, Ty::Text)?;
                    Ty::Text
                }
                "TODAY" | "NOW" => Ty::Date,
                "EMPTY" => Ty::Any,
                "DATE" => {
                    all(Ty::Num)?;
                    Ty::Date
                }
                "YEAR" | "MONTH" | "DAY" | "WEEKDAY" => {
                    at(0, Ty::Date)?;
                    Ty::Num
                }
                "DATEADD" => {
                    at(0, Ty::Date)?;
                    at(1, Ty::Num)?;
                    at(2, Ty::Text)?;
                    Ty::Date
                }
                "DATEDIFF" => {
                    at(0, Ty::Date)?;
                    at(1, Ty::Date)?;
                    at(2, Ty::Text)?;
                    Ty::Num
                }
                _ => Ty::Any,
            }
        }
    })
}
