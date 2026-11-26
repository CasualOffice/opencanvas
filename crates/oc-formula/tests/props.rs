// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! Property tests: the printer round-trips through the parser, nothing panics on any input,
//! normalising is idempotent and keeps the value, and arithmetic laws hold.

use oc_formula::syntax::{Expr, Node, parse, print};
use oc_formula::{Value, eval, normalize};
use proptest::prelude::*;

fn get(name: &str) -> Value {
    match name {
        "A" => Value::Num(3.0),
        "B" => Value::Text("x".into()),
        "C" => Value::Bool(true),
        _ => Value::Empty,
    }
}

fn node(e: Expr) -> Node {
    Node { e, pos: 0 }
}

fn strip(n: &Node) -> Node {
    node(match &n.e {
        Expr::Call(f, a) => Expr::Call(f.clone(), a.iter().map(strip).collect()),
        Expr::Neg(x) => Expr::Neg(Box::new(strip(x))),
        Expr::Bin(o, a, b) => Expr::Bin(o, Box::new(strip(a)), Box::new(strip(b))),
        e => e.clone(),
    })
}

fn ast() -> impl Strategy<Value = Node> {
    let leaf = prop_oneof![
        (0u32..100_000).prop_map(|n| node(Expr::Num(f64::from(n) / 8.0))),
        "[a-z \"]{0,6}".prop_map(|s| node(Expr::Str(s))),
        any::<bool>().prop_map(|b| node(Expr::Bool(b))),
        prop_oneof![Just("A"), Just("B"), Just("C"), Just("Price \"x\"")]
            .prop_map(|p| node(Expr::Prop(p.into()))),
    ];
    leaf.prop_recursive(5, 40, 3, |inner| {
        prop_oneof![
            inner.clone().prop_map(|x| node(Expr::Neg(Box::new(x)))),
            (
                prop_oneof![
                    Just("+"),
                    Just("-"),
                    Just("*"),
                    Just("/"),
                    Just("&"),
                    Just("="),
                    Just("<>"),
                    Just("<"),
                    Just(">="),
                ],
                inner.clone(),
                inner.clone()
            )
                .prop_map(|(o, a, b)| node(Expr::Bin(o, Box::new(a), Box::new(b)))),
            (
                prop_oneof![
                    Just("SUM"),
                    Just("IF"),
                    Just("ROUND"),
                    Just("LEN"),
                    Just("CONCAT")
                ],
                prop::collection::vec(inner, 0..4)
            )
                .prop_map(|(f, a)| node(Expr::Call(f.into(), a))),
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn printed_formulas_parse_back_to_the_same_tree(n in ast()) {
        let src = print(&n);
        let back = parse(&src).map_err(|e| TestCaseError::fail(format!("{src}: {e:?}")))?;
        prop_assert_eq!(strip(&back), strip(&n));
    }

    #[test]
    fn any_input_gives_a_value_or_an_error_never_a_panic(src in "[ -~]{0,80}") {
        let _ = eval(&src, &get, 0);
        let _ = normalize(&src);
    }

    #[test]
    fn evaluating_a_random_tree_never_panics(n in ast()) {
        let _ = eval(&print(&n), &get, 20_000);
    }

    #[test]
    fn normalising_is_idempotent_and_keeps_the_value(n in ast(), lower in any::<bool>()) {
        let src = print(&n);
        let typed = if lower { src.to_lowercase().replace("prop(\"a\")", "prop(\"A\")").replace("prop(\"b\")", "prop(\"B\")").replace("prop(\"c\")", "prop(\"C\")") } else { src.clone() };
        let once = normalize(&typed);
        prop_assert_eq!(normalize(&once), once.clone());
        if !lower {
            prop_assert_eq!(format!("{:?}", eval(&once, &get, 1)), format!("{:?}", eval(&src, &get, 1)));
        }
    }

    #[test]
    fn addition_and_multiplication_commute(a in -1e6f64..1e6, b in -1e6f64..1e6) {
        let f = |s: String| eval(&s, &get, 0);
        prop_assert_eq!(f(format!("({a}) + ({b})")), f(format!("({b}) + ({a})")));
        prop_assert_eq!(f(format!("({a}) * ({b})")), f(format!("({b}) * ({a})")));
    }

    #[test]
    fn dates_round_trip_through_text(d in -100_000i64..100_000) {
        prop_assert_eq!(oc_formula::date::parse(&oc_formula::date::format(d)), Some(d));
        let n = eval(&format!("DATEADD(DATE(2000, 1, 1), {d}, \"days\") - DATE(2000, 1, 1)"), &get, 0);
        prop_assert_eq!(n, Value::Num(d as f64));
    }
}
