// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

//! The WASM bridge: JSON in, JSON out, through linear memory. No bindgen: the editor's loader
//! (`web/packages/database/src/formula/engine.ts`) calls `oc_alloc`, writes UTF-8 JSON, calls
//! `oc_call(op, ptr, len)`, reads `(ptr << 32) | len` back and frees both buffers.

use std::alloc::{Layout, alloc, dealloc};

#[unsafe(no_mangle)]
pub extern "C" fn oc_alloc(len: usize) -> *mut u8 {
    // SAFETY: a non-zero size with byte alignment is a valid layout.
    unsafe { alloc(Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr` and `len` come from `oc_alloc` or `oc_call`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oc_free(ptr: *mut u8, len: usize) {
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(len.max(1), 1)) }
}

/// # Safety
/// `ptr..ptr+len` is a buffer from `oc_alloc` holding UTF-8 JSON.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn oc_call(op: u32, ptr: *const u8, len: usize) -> u64 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let input: serde_json::Value = serde_json::from_slice(bytes).unwrap_or(serde_json::Value::Null);
    let out = serde_json::to_vec(&crate::dispatch(op, &input)).unwrap_or_default();
    let n = out.len();
    let p = oc_alloc(n);
    // SAFETY: `p` has room for `n` bytes.
    unsafe { std::ptr::copy_nonoverlapping(out.as_ptr(), p, n) };
    ((p as u64) << 32) | n as u64
}
