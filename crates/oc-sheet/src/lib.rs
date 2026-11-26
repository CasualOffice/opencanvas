// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! `oc-sheet` (ADR-080): the Spreadsheet block's model rules, shared by the server and (as WASM)
//! the editor. Yjs is the source of truth; each sheet's rows and columns are lists of stable ids,
//! and a formula is stored with its references as those ids ([`refs`]), shown and computed as A1.
//! Inserting or deleting rows and columns is then one list edit with no formula rewrites, so
//! concurrent edits converge, and a reference to a deleted row or column reads `#REF!`.

pub mod refs;
